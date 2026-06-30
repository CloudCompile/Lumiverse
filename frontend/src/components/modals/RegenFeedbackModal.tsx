import { MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { InputPromptModal } from '@/components/shared/InputPromptModal'

interface RegenFeedbackModalProps {
  onSubmit: (feedback: string) => void
  onSkip: () => void
  onCancel: () => void
  defaultValue?: string
}

export default function RegenFeedbackModal({
  onSubmit,
  onSkip,
  onCancel,
  defaultValue,
}: RegenFeedbackModalProps) {
  const { t } = useTranslation('modals')

  return (
    <InputPromptModal
      isOpen={true}
      title={t('regenFeedback.title')}
      message={t('regenFeedback.message')}
      placeholder={t('regenFeedback.placeholder')}
      defaultValue={defaultValue}
      multiline
      submitLabel={t('regenFeedback.submit')}
      secondaryLabel={t('regenFeedback.skip')}
      onSubmit={onSubmit}
      onSecondary={onSkip}
      onCancel={onCancel}
      icon={<MessageSquareText size={16} />}
    />
  )
}
