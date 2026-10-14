import type { Clock } from '../../src/core/contracts/ports'
import type { FsDirHandle, FsFile, FsFileHandle, FsWritable } from '../../src/core/sync/providers/fs'

const domError = (name: string, m: string): Error => new DOMException(m, name)

/** Knobs shared by every handle of one fake tree. */
export interface FakeDirState {
  clock: Clock
  /** When set, every operation throws a DOMException with this name (e.g. 'NotAllowedError'). */
  failWith?: string
  /** What queryPermission answers; requestPermission grants unless 'denied'. */
  permission?: PermissionState
}

class FakeFile implements FsFileHandle {
  readonly kind = 'file'
  bytes = new Uint8Array()
  modified: number

  constructor(
    readonly name: string,
    private readonly s: FakeDirState,
  ) {
    this.modified = s.clock.now()
  }

  async getFile(): Promise<FsFile> {
    if (this.s.failWith) throw domError(this.s.failWith, `getFile ${this.name}`)
    const bytes = this.bytes.slice()
    return { size: bytes.length, lastModified: this.modified, arrayBuffer: async () => bytes.buffer }
  }

  /** Like the browser: writes go to a swap buffer, applied on close, dropped on abort. */
  async createWritable(): Promise<FsWritable> {
    if (this.s.failWith) throw domError(this.s.failWith, `createWritable ${this.name}`)
    const chunks: Uint8Array[] = []
    return {
      write: async (d) => {
        if (this.s.failWith) throw domError(this.s.failWith, `write ${this.name}`)
        chunks.push(d.slice())
      },
      close: async () => {
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        this.bytes = out
        this.modified = this.s.clock.now()
      },
      abort: async () => {
        chunks.length = 0
      },
    }
  }
}

/** In-memory FileSystemDirectoryHandle with the browser's error names (NotFound, TypeMismatch). */
export class FakeDir implements FsDirHandle {
  readonly kind = 'directory'
  readonly children = new Map<string, FakeDir | FakeFile>()

  constructor(
    readonly name: string,
    readonly state: FakeDirState = { clock: { now: () => 0 } },
  ) {}

  private child(name: string): FakeDir | FakeFile | undefined {
    if (this.state.failWith) throw domError(this.state.failWith, `open ${name}`)
    return this.children.get(name)
  }

  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FakeDir> {
    const c = this.child(name)
    if (c instanceof FakeDir) return c
    if (c) throw domError('TypeMismatchError', `${name} is a file`)
    if (!o?.create) throw domError('NotFoundError', `${name} not found`)
    const d = new FakeDir(name, this.state)
    this.children.set(name, d)
    return d
  }

  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFileHandle> {
    const c = this.child(name)
    if (c instanceof FakeFile) return c
    if (c) throw domError('TypeMismatchError', `${name} is a directory`)
    if (!o?.create) throw domError('NotFoundError', `${name} not found`)
    const f = new FakeFile(name, this.state)
    this.children.set(name, f)
    return f
  }

  async queryPermission(): Promise<PermissionState> {
    return this.state.permission ?? 'granted'
  }

  async requestPermission(): Promise<PermissionState> {
    if (this.state.permission !== 'denied') this.state.permission = 'granted'
    return this.state.permission
  }

  async *values(): AsyncIterable<FakeDir | FsFileHandle> {
    if (this.state.failWith) throw domError(this.state.failWith, `values ${this.name}`)
    yield* [...this.children.values()]
  }

  /** Test helper: drops a file at a slash path, creating folders (e.g. a stray .DS_Store). */
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const parts = path.split('/')
    const name = parts.pop() as string
    let d: FakeDir = this
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
    const w = await (await d.getFileHandle(name, { create: true })).createWritable()
    await w.write(bytes)
    await w.close()
  }
}

/**
 * A structured-cloneable stand-in for a FileSystemDirectoryHandle: plain data only, as IndexedDB
 * would hand back after a reload (a browser handle clones natively; a FakeDir holds functions).
 */
export function cloneableDir(name: string): FsDirHandle {
  const data: Pick<FsDirHandle, 'kind' | 'name'> = { kind: 'directory', name }
  return data as FsDirHandle
}
