const path = require('path')
const EventEmitter = require('events')

// FIXME
const debug = require('debug')('forest')

const mkdirp = require('mkdirp')
const { forceXstat } = require('../lib/xstat') 
const Directory = require('./directory')
// const File = require('./file')

/**
Forest is a collection of file system cache for each `Drive` defined in Fruitmix.

Forest provides two critical services to other parts of Fruitmix: looking up file path by uuid or by file hash.

```
for directory: (driveUUID, dirUUID) -> abspath
for regular file: (driveUUID, dirUUID, fileUUID, filename) -> abspath
```

There are three types message from external components notifying a possible file system change, or a file path retrieved from forest does not work.

First, for samba, it simply notifies a directory is changed. The directory is provided as an absolute path.

In this case, a path walk is performed. If the corresponding `Directory` object is found, a `read` is requested. If it is not found, a `read` on the last one is requested. This is a simple solution. But it won't fix errors deeply nested inside the subtree.

It is possible to repeat the process until it is impossibe to go further. Don't know if it helps, for the `read` operation itself may raise errors.

We don't have a finally correct solution without a fully scan of the file system. All solutions are just best effort.

Second, for rest api router. After an operation is finished, it should provide both dir uuid and affected directory to forest. Forest firstly verify the abspath matches. If it does, a `read` is requested. If it doesn't, a pathwalk `read` is also tried.

Third, if an external component, such as box or media, get a file path from forest, by file hash, take some action, and then got a path error, including EINSTANCE, or a file change is detected, for example, type changed or hash dropped. It should notify the forest with detail.

In either case, a `read` on the `Directory` object is enough.

@module Forest
*/

class Forest extends EventEmitter {

  constructor (froot, mediaMap) {
    super()

    /**
    Absolute path of Fruitmix drive directory 
    */
    this.dir = path.join(froot, 'drives')

    mkdirp.sync(this.dir)

    /**
    fruitmix
    */
    this.mediaMap = mediaMap

    /**
    The collection of drive cache. Using Map for better performance 
    */ 
    this.roots = new Map()

    /**
    All directories indexed by uuid
    */
    this.uuidMap = new Map()
    
    /**
    dirs in init state. (dir may or may not have a timer)
    */
    this.initDirs = new Set()

    /**
    dirs in pending state
    */
    this.pendingDirs = new Set()

    /**
    dir in readding state
    */
    this.readingDirs = new Set()

    /**
    files has no hash/fingerprint
    */
    this.hashlessFiles = new Set()

    /**
    files that are calculating hash/fingerprint
    */
    this.hashingFiles = new Set()

    /**
    files that failed too many times in calcuating hash/fingerprint
    */
    this.hashFailedFiles = new Set()
  }

  fileEnterHashless (file) {
    debug(`file ${file.name} enter hashless`)
    this.hashlessFiles.add(file)
  }

  fileExitHashless (file) {
    debug(`file ${file.name} exit hashless`)
    this.hashlessFiles.delete(file)
  }

  fileEnterHashing (file) {
    debug(`file ${file.name} enter hashing`)
    this.hashingFiles.add(file)
  }

  fileExitHashing (file) {
    debug(`file ${file.name} exit hashing`)
    this.hashingFiles.delete(file)
  }

  fileEnterHashFailed (file) {
    debug(`file ${file.name} enter hash failed`)
    this.hashFailedFiles.add(file)
  }

  fileExitHashFailed (file) {
    debug(`file ${file.name} exit hash failed`)
    this.hashFailedFiles.delete(file)
  }

  fileEnterHashed (file) {
    debug(`file ${file.name} enter hashed`)
    this.mediaMap.indexFile(file)
  }

  fileExitHashed (file) {
    debug(`file ${file.name} exit hashed`)
    this.mediaMap.unindexFile(file)
  }

  reqSchedFileHash () {
    if (this.fileHashScheduled) return
    this.fileHashScheduled = true
    process.nextTick(() => this.scheduleFileHash())
  }

  scheduleFileHash () {
    this.fileHashScheduled = false
    while (this.hashlessFiles.size > 0 && this.hashingFiles.size < 2) {
      let file = this.hashlessFiles[Symbol.iterator]().next().value

      // FIXME
      file.calcFingerprint()
    } 
  }

  indexDirectory (dir) {
    debug(`index dir ${dir.name}`)
    this.uuidMap.set(dir.uuid, dir)
  }

  unindexDirectory (dir) {
    debug(`unindex dir ${dir.name}`)
    this.uuidMap.delete(dir.uuid)
  }

  dirEnterInit (dir) {
    debug(`dir ${dir.name} enter init`)
    this.initDirs.add(dir.uuid)
    this.reqSchedDirRead()
  }

  dirExitInit (dir) {
    debug(`dir ${dir.name} exit init`)
    this.initDirs.delete(dir.uuid)
    this.reqSchedDirRead()
  }

  dirEnterPending (dir) {
    debug(`dir ${dir.name} enter pending`)
    this.pendingDirs.add(dir.uuid)
    this.reqSchedDirRead()
  }

  dirExitPending (dir) {
    debug(`dir ${dir.name} exit pending`)
    this.pendingDirs.delete(dir.uuid)
    this.reqSchedDirRead()
  }

  dirEnterReading (dir) {
    debug(`dir ${dir.name} enter reading`)
    this.readingDirs.add(dir.uuid)
    this.reqSchedDirRead()
  }

  dirExitReading (dir) {
    debug(`dir ${dir.name} exit reading`)
    this.readingDirs.delete(dir.uuid)
    this.reqSchedDirRead()
  }

  reqSchedDirRead () {
    if (this.dirReadScheduled) return
    this.dirReadScheduled = true
    process.nextTick(() => this.scheduleDirRead())
  }

  dirReadSettled () {
    return this.initDirs.size === 0 &&
      this.pendingDirs.size === 0 &&
      this.readingDirs.size === 0
  }

  scheduleDirRead () {
    this.dirReadScheduled = false
    if (this.dirReadSettled()) {
      console.log('all directories probed', this.uuidMap.size)
      return this.emit('dirReadSettled')
    }

    while (this.initDirs.size > 0 && this.readingDirs.size < 6) {
      let uuid = this.initDirs[Symbol.iterator]().next().value
      let dir = this.uuidMap.get(uuid)
      if (dir) dir.read() // FIXME
    }
  }

  createRoot (uuid, callback) {
    let dirPath = path.join(this.dir, uuid)
    mkdirp(dirPath, err => {
      if (err) return callback(err)
      forceXstat(dirPath, { uuid }, (err, xstat) => {
        if (err) return callback(err)
        let root = new Directory(this, null, xstat)
        this.roots.set(uuid, root)
        callback(null, root) 
      })
    })
  }

}

module.exports = Forest

