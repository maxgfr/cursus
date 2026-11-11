// turndown ships no types and @types/turndown is not a dependency: the slice we use.
declare module 'turndown' {
  interface Options {
    headingStyle?: 'setext' | 'atx'
    codeBlockStyle?: 'indented' | 'fenced'
    emDelimiter?: '_' | '*'
  }
  interface Rule {
    filter: string | string[]
    replacement: (content: string, node: HTMLElement) => string
  }
  export default class TurndownService {
    constructor(options?: Options)
    addRule(key: string, rule: Rule): this
    turndown(html: string): string
  }
}
