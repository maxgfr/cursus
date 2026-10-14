// turndown ships no types and @types/turndown is not a dependency: the slice we use.
declare module 'turndown' {
  interface Options {
    headingStyle?: 'setext' | 'atx'
    codeBlockStyle?: 'indented' | 'fenced'
    emDelimiter?: '_' | '*'
  }
  export default class TurndownService {
    constructor(options?: Options)
    turndown(html: string): string
  }
}
