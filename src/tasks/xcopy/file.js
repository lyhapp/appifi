const Node = require('./node')

class State {

  constructor(file, ...args) {
    this.file = file
    this.enter(...args)
  }

  destroy () {
    this.exit()
  }

  setState (NextState, ...args) {
    this.exit()
    new NextState(this.file, ...args)
  }

  resolve () {
  }

  enter () {
  }

  exit () {
  }
}

class Pending extends State {

  enter () {
    this.file.ctx.indexPendingFile(this.file)
  }

  exit () {
    this.file.ctx.unindexPendingFile(this.file)
  }
}

class Working extends State {
  
  enter () {
    this.file.ctx.indexWorkingFile(this.file)

    let srcDirUUID = this.file.parent.srcUUID
    let dstDirUUID = this.file.parent.dstUUID
    let fileUUID = this.file.srcUUID
    let fileName = this.file.srcName
    let policy = this.file.getPolicy()

    this.file.ctx.cpFile(srcDirUUID, fileUUID, fileName, dstDirUUID, policy, (err, xstat, resolved) => {
      if (err) {
        if (err.xcode === 'ECONFLICT') {
          this.setState(Conflict, err, policy) 
        } else {
          this.setState(Failed, err)
        }
      } else {
        this.setState(Finished)
      }
    }) 
  }

  exit () {
    this.file.ctx.unindexWorkingFile(this.file)
  }
}

class Conflict extends State {

  enter () {
    this.file.ctx.indexConflictFile(this.file)
  }

  resolve () {
    if (this.policy !== this.dir.getPolicy()) {
      this.setState(Working)
    }
  }

  exit () {
    this.file.ctx.unindexConflictFile(this.file)
  }
}

class Failed extends State {

  enter (e) {
    this.file.ctx.indexFailedFile(this.file)
    console.log(e, e.stack)
    this.file.emit('error', e)
  }

  exit () {
    this.file.ctx.unindexWorkingFile(this.file)
  }
}

class Finished extends State {

  enter () {
    this.file.ctx.indexFinishedFile(this.file)
    this.file.emit('finish')
  }

  exit () {
    this.file.ctx.unindexFinishedFile(this.file)
  }
}

class File extends Node {

  constructor(ctx, parent, srcUUID, srcName) {
    super(ctx, parent)
    this.srcUUID = srcUUID
    this.srcName = srcName

    this.state = new Pending(this)
  }

  destroy (detach) {
    this.state.destroy()
    super.destroy(detach)
  }

  setState (NextState) {
    this.state.setState(NextState)
  }

  view () {
    let obj = {
      type: 'directory',
      parent: this.parent && this.parent.srcUUID,
      srcUUID: this.srcUUID
    }

    if (this.dstUUID) obj.dstUUID = this.dstUUID
    obj.state = this.state.constructor.name
    if (this.policy) obj.policy = this.policy
    return obj
  }

  getPolicy () {
    return this.policy || this.ctx.policies.file || null
  } 

  setPolicy (policy) {
    this.policy = policy
  }

  resolve () {
    this.state.resolve()
  }  
}

File.Pending = Pending
File.Working = Working
File.Conflict = Conflict
File.Finished = Finished
File.Failed = Failed

module.exports = File




