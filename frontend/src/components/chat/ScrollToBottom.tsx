import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown } from 'lucide-react'
import styles from './ScrollToBottom.module.css'

const CHAT_SCROLL_TO_BOTTOM_EVENT = 'lumiverse:chat-scroll-bottom'

export default function ScrollToBottom() {
  const { t } = useTranslation('chat')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const list = document.querySelector('[data-chat-scroll="true"]') as HTMLElement | null
    if (!list) return

    const handleScroll = () => {
      const threshold = 300
      const isNearBottom =
        list.scrollHeight - list.scrollTop - list.clientHeight < threshold
      setVisible(!isNearBottom)
    }

    const resizeObserver = new ResizeObserver(handleScroll)
    resizeObserver.observe(list)
    list.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => {
      resizeObserver.disconnect()
      list.removeEventListener('scroll', handleScroll)
    }
  }, [])

  const scrollDown = useCallback(() => {
    window.dispatchEvent(new Event(CHAT_SCROLL_TO_BOTTOM_EVENT))
  }, [])

  if (!visible) return null

  return (
    <button type="button" className={styles.btn} onClick={scrollDown} aria-label={t('scrollToBottom')}>
      <ArrowDown size={18} />
    </button>
  )
}
