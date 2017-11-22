const Node = require('./node')
const File = require('./file')

class State {

  constructor(dir, ...args) {
    this.dir = dir
    this.dir.state = this
    this.enter(...args)
  }

  destroy () {
    this.exit()
  }

  setState (NextState, ...args) {
    this.exit()
    new NextState(this.dir, ...args)
  }

  retry () {
  }

  enter () {
  }

  exit () {
  }
}

class Pending extends State {

  enter () {
    this.dir.ctx.indexPendingDir(this.dir)
  }

  exit () {
    this.dir.ctx.unindexPendingDir(this.dir)
  } 
}

class Making extends State {
  
  enter () {
    this.dir.ctx.indexMakingDir(this.dir)
    let srcDirUUID = this.dir.srcUUID
    let dstDirUUID = this.dir.parent.dstUUID
    let policy = this.dir.getPolicy()

    this.dir.ctx.mkdirc(srcDirUUID, dstDirUUID, policy, (err, xstat) => {
      if (err && err.code === 'EEXIST') {
        this.setState(Conflict, err, policy)
      } else if (err) {
        this.setState(Failed, err)
      } else {
        this.dir.dstUUID = xstat.uuid
        this.setState(Reading)
      }
    })
  }

  exit () {
    this.dir.ctx.unindexMakingDir(this.dir)
  }
}

class Conflict extends State {

  enter (err, policy) {
    this.err = err
    this.policy = policy
    this.dir.ctx.indexConflictDir(this.dir)
  }

  retry () {
    this.setState(Making)
  }

  exit () {
    this.dir.ctx.unindexConflictDir(this.dir)
  }
}

class Reading extends State {

  enter () {
    this.dir.ctx.indexReadingDir(this.dir)

    this.dir.ctx.vfs.readdir(this.dir.srcUUID, (err, xstats) => {
      if (err) {
        this.setState(Failed, err)
      } else {
        this.setState(Read, xstats)
      }
    })
  } 

  exit () {
    this.dir.ctx.unindexReadingDir(this.dir)
  }

}

class Read extends State {

  enter (xstats) {
    this.dir.ctx.indexReadDir(this.dir)
    this.dir.dstats = xstats.filter(x => x.type === 'directory')
    this.dir.fstats = xstats.filter(x => x.type === 'file')
    this.next()
  }

  next () {

    if (this.dir.fstats.length) {
      let fstat = this.dir.fstats.shift()
      let file = new File(this.dir.ctx, this.dir, fstat.uuid, fstat.name)
      file.on('error', err => { 
        // TODO
        this.next()
      })

      file.on('finish', () => (file.destroy(true), this.next()))
      return
    }

    if (this.dir.dstats.length) {
      let dstat = this.dir.dstats.shift()
      let dir = new Directory(this.dir.ctx, this.dir, dstat.uuid)
      dir.on('error', err => {
        // TODO
        this.next()
      })

      dir.on('finish', () => (dir.destroy(true), this.next()))
      return
    } 

    if (this.dir.children.length === 0) {
      this.setState(Finished)
    }
  }

  exit () {
    this.dir.ctx.unindexReadDir(this.dir)
  }
}

class Failed extends State {
  // when directory enter failed 
  // all descendant node are destroyed (but not removed)
  enter (err) {
    this.dir.ctx.indexFailedDir(this.dir)
    this.dir.children.forEach(c => c.destroy())
    this.dir.emit('error', err)
  }

  exit () {
    this.dir.ctx.unindexFailedDir(this.dir)
  }
}

class Finished extends State {

  enter () {
    this.dir.ctx.indexFinishedDir(this.dir)
    this.dir.emit('finish')
  }

  exit () {
    this.dir.ctx.unindexFinishedDir(this.dir)
  }
}

class Directory extends Node {

  // dstUUID and xstats must be provided together
  constructor(ctx, parent, srcUUID, dstUUID, xstats) {
    super(ctx, parent)
    this.children = []
    this.srcUUID = srcUUID

    if (dstUUID) {
      this.dstUUID = dstUUID
      new Read(this, xstats)
    } else {
      new Pending(this)
    } 
  }

  destroy (detach) {
    this.children.forEach(c => c.destroy())
    this.state.destroy ()
    super.destroy(detach)
  }

  setState (NextState) {
    this.state.setState(NextState)
  }

  // change to event emitter
  onChildFinish (child) {
    child.destroy()
    if (this.children.length === 0) {
      console.log('done')  
    }
  }

  view () {
    let obj = {
      type: 'directory',
      parent: this.parent && this.parent.srcUUID,
      srcUUID: this.srcUUID,
    }
    
    if (this.dstUUID) obj.dstUUID = this.dstUUID
    obj.state = this.state.constructor.name
    if (this.policies) obj.policy = this.policy
    return obj
  }

  setPolicy (type, policy) {
    if (type === 'same') {
      this.policy[0] = policy
    } else {
      this.policy[1] = policy
    }
    this.retry()
  }

  getPolicy () {
    return [
      this.policy[0] || this.ctx.policies.dir[0] || null,
      this.policy[1] || this.ctx.policies.dir[1] || null
    ]  
  }

  retry () {
    if (this.children) this.children.forEach(c => c.retry())
    this.state.retry()
  }
}

Directory.Pending = Pending
Directory.Making = Making
Directory.Reading = Reading
Directory.Conflict = Conflict
Directory.Finished = Finished
Directory.Failed = Failed

module.exports = Directory








