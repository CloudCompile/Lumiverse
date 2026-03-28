import { useState } from 'react'
import { X } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { Button } from '@/components/shared/FormComponents'
import type { Pack } from '@/types/api'
import styles from './PackBrowser.module.css'

interface Props {
  initialData?: Pack
  onSave: (data: { name: string; author: string; cover_url: string }) => void
  onClose: () => void
}

export default function PackEditorModal({ initialData, onSave, onClose }: Props) {
  const [name, setName] = useState(initialData?.name || '')
  const [author, setAuthor] = useState(initialData?.author || '')
  const [coverUrl, setCoverUrl] = useState(initialData?.cover_url || '')

  const isEditing = !!initialData

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={480} maxHeight="90vh" zIndex={10001} className={styles.modal}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>{isEditing ? 'Edit Pack' : 'New Pack'}</h2>
        <Button size="icon" variant="ghost" onClick={onClose} icon={<X size={16} />} />
      </div>
      <div className={styles.modalBody}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Name *</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Pack"
            autoFocus
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Author</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name"
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Cover Image URL</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>
      </div>
      <div className={styles.modalFooter}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!name.trim()}
          onClick={() => onSave({ name: name.trim(), author: author.trim(), cover_url: coverUrl.trim() })}
        >
          {isEditing ? 'Save' : 'Create'}
        </Button>
      </div>
    </ModalShell>
  )
}
