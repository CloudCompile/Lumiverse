import { X } from 'lucide-react'
import clsx from 'clsx'
import styles from './CloseButton.module.css'

interface CloseButtonProps {
  onClick: () => void
  size?: 'sm' | 'md'
  variant?: 'subtle' | 'solid'
  position?: 'static' | 'absolute'
  iconSize?: number
  className?: string
}

export function CloseButton({
  onClick,
  size = 'md',
  variant = 'subtle',
  position = 'static',
  iconSize,
  className,
}: CloseButtonProps) {
  const resolvedIconSize = iconSize ?? (size === 'sm' ? 14 : 16)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      className={clsx(
        styles.closeBtn,
        styles[size],
        styles[variant],
        position === 'absolute' && styles.absolute,
        className,
      )}
    >
      <X size={resolvedIconSize} />
    </button>
  )
}
