import 'lumiverse-spindle-types'

declare module 'lumiverse-spindle-types' {
  interface SpindleFloatWidgetHandle {
    setSize(width: number, height: number): void
  }

  interface SpindleInputBarActionOptions {
    subtitle?: string
  }

  interface SpindleInputBarActionHandle {
    setSubtitle(subtitle?: string): void
  }
}

export {}
