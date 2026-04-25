import 'lumiverse-spindle-types'

declare module 'lumiverse-spindle-types' {
  interface SpindleInputBarActionOptions {
    subtitle?: string
  }

  interface SpindleInputBarActionHandle {
    setSubtitle(subtitle?: string): void
  }
}

export {}
