const EventEmitter = require('events')
const crypto = require('crypto')
const stream = require('stream')
// const IncomingMessage = require('http').IncomingMessage

const Dicer = require('dicer')
const sanitize = require('sanitize-filename')

const HashStream = require('../../lib/hash-stream')
const { isUUID, isSHA256 } = require('../../lib/assertion')

/**
Incoming form parses an incomming formdata and execute vfs operations accordingly.

                destroy     job finished
Heading         fail          
Parsing         fail        
Piping          fail
Pending                     stay, fail, execute
Executing

@module IncomingForm
*/

/**
Base state class
*/
class State {

  constructor (ctx, ...args) {
    this.ctx = ctx
    this.ctx.state = this
    this.enter(...args)
    process.nextTick(() => this.ctx.emit('StateEntered', this.constructor.name))
  }

  setState (NextState, ...args) {
    this.exit()
    new NextState(this.ctx, ...args)
  }

  enter () {}
  exit () {}

  onJobFailed (job) {}
  onJobSucceeded (job) {}

  _destroy () {
    let err = new Error('destroyed')
    err.code = 'EDESTROYED'
    this.setState(Failed, err)
  }

  destroy () {}

}

/**
The job is failed, no reaction
*/
class Failed extends State {

  enter (err) {
    this.error = err
  }

}

/**
The job is finished, no reaction
*/
class Succeeded extends State {

  enter (data) {
    this.data = data
  }

}

/**
Waiting for part header, react to destroyed

1. job failed or succeeded events are irrelevent.
2. synchronous transition to failed when destroyed.
*/
class Heading extends State {

  enter (part) {
    part.on('error', err => {
      this.setState(Failed, err)
    })

    part.on('header', header => {
      let args
      try {
        args = this.parseHeader(header)
      } catch (e) {
        e.status = 400
        return this.setState(Failed, e)
      }

      if (args.type === 'file') {
        try {
          this.validateFileArgs(args)
        } catch (e) {
          e.status = 400
          return this.setState(Failed, e)
        }
      }

      /**
      name directive parsed, stamp ctx.prev here
      */
      this.ctx.predecessor = this.ctx.ctx.jobs
        .slice(0, this.ctx.ctx.jobs.indexOf(this.ctx))
        .reverse()
        .find(j => j.args.toName === args.fromName)

      // go to next state
      if (args.type === 'file') {
        this.setState(Piping, this.part, args)
      } else {
        this.setState(Parsing, this.part, args)
      }
    })

    this.part = part
  }

  /**
  Parse name and filename directive according to protocol
  */
  parseHeader (header) {
    let name, filename, fromName, toName

    // fix %22
    // let x = header['content-disposition'][0].split('; ')
    let x = Buffer.from(header['content-disposition'][0], 'binary')
      .toString('utf8')
      .replace(/%22/g, '"')
      .split('; ')

    if (x[0] !== 'form-data') throw new Error('not form-data')
    if (!x[1].startsWith('name="') || !x[1].endsWith('"')) throw new Error('invalid name')
    name = x[1].slice(6, -1)

    // validate name and generate part.fromName and .toName
    let split = name.split('|')
    if (split.length === 0 || split.length > 2) throw new Error('invalid name')
    if (!split.every(name => name === sanitize(name))) throw new Error('invalid name')
    fromName = split.shift()
    toName = split.shift() || fromName

    if (x.length > 2) {
      if (!x[2].startsWith('filename="') || !x[2].endsWith('"')) throw new Error('invalid filename')
      filename = x[2].slice(10, -1)

      // validate part.filename and generate part.opts
      let { size, sha256, append, overwrite } = JSON.parse(filename)
      let op = append ? 'append' : 'newfile'
      return { type: 'file', op, name, fromName, toName, size, sha256, append, overwrite }
    } else {
      return { type: 'field', name, fromName, toName }
    }
  }

  validateFileArgs (args) {
    if (args.append !== undefined && !isSHA256(args.append)) {
      throw new Error('append is not a valid fingerprint string')
    }

    if (args.overwrite !== undefined && !isUUID(args.overwrite)) {
      throw new Error('overwrite is not a valid uuid string')
    }

    if (!Number.isInteger(args.size)) { throw new Error('size must be an integer') }

    if (args.size > 1024 * 1024 * 1024) { throw new Error('size must be less than or equal to 1 Giga') }

    if (args.op === 'append') {
      if (args.size < 1) { throw new Error(`data size must be a positive integer, got ${args.size}`) }
    } else {
      if (args.size < 0) { throw new Error(`data size must be a non-negative integer, got ${args.size}`) }
    }

    if (args.size === 0) {
      // forcefully do this, even if wrong value provided
      args.sha256 = EMPTY_SHA256_HEX
    } else {
      if (!isSHA256(args.sha256)) throw new Error('invalid sha256')
    }
  }

  exit () {
    this.part.removeAllListeners()
    this.part.on('error', () => {})
  }

  destroy () {
    this._destroy()
  }

}

/**
Streaming part body to buffer, in field job.

1. job failed or succeeded events are irrelevant.
2. sychronous transition to failed when destroyed.
*/
class Parsing extends State {

  enter (part, args) {
    this.ctx.args = args
    this.buffers = []

    part.on('data', data => this.buffers.push(data))
    part.on('end', () => {
      let args
      try {
        args = Object.assign({}, JSON.parse(Buffer.concat(this.buffers)))
        this.validateFieldArgs(args)
      } catch (e) {
        e.status = 400
        return this.setState(Failed, e)
      }

      Object.assign(this.ctx.args, args)

      if (this.ctx.predecessor && !this.ctx.predecessor.isFinished()) {
        this.setState(Pending)
      } else {
        this.setState(Executing)
      }
    })

    this.part = part
  }

  validateFieldArgs (args) {
    switch (args.op) {
      case 'mkdir':
        if (args.hasOwnProperty('parents') && args.parents !== true) {
          throw new Error('parents must be true if provided')
        }
        break

      case 'dup':
        if (args.fromName === args.toName) {
          throw new Error('dup requires two distinct names')
        }
        if (args.hasOwnProperty('overwrite') && !isUUID(args.overwrite)) {
          throw new Error('overwrite must be valid uuid if provided')
        }
        break

      case 'rename':
        if (args.fromName === args.toName) {
          throw new Error('rename requires two distinct names')
        }
        if (args.hasOwnProperty('overwrite') && !isUUID(args.overwrite)) {
          throw new Error('overwrite must be valid uuid if provided')
        }
        break

      case 'remove':
        if (!isUUID(args.uuid)) throw new Error('invalid uuid')
        break

      case 'addTags':
        if (!Array.isArray(args.tags) || args.tags.every(t => isUUID(t))) throw new Error('invalid tagId')
        break

      case 'removeTags':
        if (!Array.isArray(args.tags) || args.tags.every(t => isUUID(t))) throw new Error('invalid tagId')
        break

      case 'setTags':
        if (!Array.isArray(args.tags) || args.tags.every(t => isUUID(t))) throw new Error('invalid tagId')
        break

      case 'resetTags':
        break

      default:
        throw new Error('invalid op')
    }
  }

  exit () {
    this.part.removeAllListeners()
    this.part.on('error', () => {})
  }

  destroy () {
    this._destroy()
  }
}

/**
Pending field or file job

Go to failed or executing when job finished. Ignore destroy
*/
class Pending extends State {

  onJobFailed (job) {
    if (job === this.ctx.predecessor) this.setState(Failed, new Error('predecessor failed'))
  }

  onJobSucceeded (job) {
    if (job === this.ctx.predecessor) this.setState(Executing)
  }

}

/**
Commit the final operation to VFS

Ignore all events
*/
class Executing extends State {

  enter () {
    let job = this.ctx
    if (job.type === 'file') {

    } else {
      switch (job.args.op) {
        case 'mkdir':
          this.ctx.ctx.apis.mkdir({ 
            name: job.args.toName,
            policy: job.args.policy
          }, (err, xstat, resolved) => {
            if (err) {
              this.setState(Failed, err)
            } else {
              job.args.resolved = resolved
              this.setState(Succeeded, xstat)
            }
          })
          break

        default:
          console.log('invalid job op', job.op)
          break
      }
    }
  }

}

/**
Job starts from a part and finally reached failed or succeeded.

A job is a state machine. It has the following states:

1. heading
2. parsing
3. parsed
4. piping
5. piped
6. executing
7. failed
8. succeeded

*/
class Job extends EventEmitter {

  constructor (ctx, part) {
    super()
    this.ctx = ctx
    new Heading(this, part)
  }

  isSucceeded () {
    return this.state.constructor === Succeeded
  }

  isFailed () {
    return this.state.constructor === Failed
  }

  isFinished () {
    return this.isFailed() || this.isSucceeded()
  }

  onJobFailed (job) {
    this.state.onJobFailed(job)
  }

  onJobSucceeded (job) {
    this.state.onJobSucceeded(job)
  }

  destroy () {
    this.state.destroy()
  }

}

/**
Party handles part

Party is a (s -> 0 | s => e -> 0) reactor. Noting that s -> 0 may reach finish and failed state.
*/
class Party extends EventEmitter {

  constructor(apis) {
    super()
    this.error = null
    this.ended = false
    this.finished = false
    this.apis = apis
    this.jobs = [] 
  }

  result () {
    return this.jobs.filter(j => j.isFinished())
      .map(j => {
        if (j.isFailed()) {
          let { status, code, xcode, message, syscall, path } = j.state.error
          return Object.assign({}, j.args, { error: { status, code, xcode, message, syscall, path } })
        } else {
          return Object.assign({}, j.args, { data: j.state.data })
        }
      })
  }

  write (part) {
    if (this.finished || this.error) return    

    let job = new Job(this, part) 
    job.on('StateEntered', state => {
      if (!job.isFinished()) return

      if (this.ended && this.jobs.every(j => j.isFinished())) {
        // mute , due to asynchrony of state event
        this.jobs.forEach(j => j.removeAllListeners()) 
        if (!this.error && job.isFailed()) this.error = job.state.error
        this.finished = true
        return this.emit('finish')
      }

      if (this.error) { // E state
        this.jobs.forEach(j => job.isFailed() ? j.onJobFailed(job) : j.onJobSucceeded(job))
      } else {          // S state
        if (job.isFailed()) { // first error
          this.jobs.forEach(j => j.onJobFailed())
          this.jobs.forEach(j => j.destroy())
          this.error = jobs.state.error
          this.emit('error', this.error)
        } else {
          this.jobs.forEach(j => j.onJobSucceeded())
        }
      }

    })

    this.jobs.push(job)
  } 

  end () {
    if (this.finished || this.ended) return

    if (this.jobs.every(j => j.isFinished())) {
      // mute
      this.jobs.forEach(j => j.removeAllListeners())
      this.finished = true 
      process.nextTick(() => this.emit('finish'))
    } else {
      this.ended = true
    }
  }

  destroy () {
    if (this.finished || this.error) return
    this.error = new Error('destroyed')
    this.error.code = 'EDESTROYED'
    this.jobs.forEach(j => j.destroy())
  }
}

/**
IncomingForm

formdata -> dicer -> party
*/
class IncomingForm extends EventEmitter {

  constructor (opts, apis) {
    super()

    let { boundary, formdata } = opts
    this.error = null

    this.errorHandler = err => {
      this.error = err

      this.formdata.unpipe()
      this.formdata.removeListener('error', this.errorHandler)
      this.formdata.on('error', () => {})

      this.dicer.removeAllListeners()
      this.dicer.on('error', () => {})

      this.party.removeListener('error', this.errorHandler)
      this.party.on('error', () => {})
    }

    this.party = new Party(apis)
    this.party.on('error', this.errorHandler)
    this.party.on('finish', () => {
      // Noting that party may finish in error
      this.error = this.error || this.party.error
      if (this.error) {
        this.error.result = this.party.result()
      } else {
        this.result = this.party.result()
      }

      this.emit('finish')
    })

    this.dicer = new Dicer({ boundary })
    this.dicer.on('part', part => this.party.write(part))
    this.dicer.on('error', this.errorHandler)
    this.dicer.on('finish', () => this.party.end())

    this.formdata = formdata
    this.formdata.on('error', this.errorHandler)
    this.formdata.pipe(this.dicer)
  }

}

module.exports = IncomingForm
