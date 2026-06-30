import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import type { CreateMcpServerInput } from '@/api/mcp-servers'
import styles from '../../panels/ConnectionManager.module.css'
import formStyles from './McpServerForm.module.css'

interface HeaderRow {
  key: string
  value: string
}

interface McpServerFormProps {
  initial?: Partial<CreateMcpServerInput> & { initialHeaders?: HeaderRow[] }
  onSave: (input: CreateMcpServerInput) => void
  onCancel: () => void
}

export default function McpServerForm({ initial, onSave, onCancel }: McpServerFormProps) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')

  const transportOptions = useMemo(
    () => [
      { value: 'streamable_http', label: t('mcp.transportStreamable') },
      { value: 'sse', label: t('mcp.transportSse') },
      { value: 'stdio', label: t('mcp.transportStdio') },
    ],
    [t],
  )

  const [name, setName] = useState(initial?.name || '')
  const [transportType, setTransportType] = useState<string>(initial?.transport_type || 'streamable_http')
  const [url, setUrl] = useState(initial?.url || '')
  const [command, setCommand] = useState(initial?.command || '')
  const [args, setArgs] = useState(initial?.args?.join(', ') || '')
  const [headers, setHeaders] = useState<HeaderRow[]>(initial?.initialHeaders || [{ key: '', value: '' }])
  const [envVars, setEnvVars] = useState<HeaderRow[]>(
    initial?.env
      ? Object.entries(initial.env).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }]
  )
  const [autoConnect, setAutoConnect] = useState(initial?.auto_connect !== false)
  const [enabled, setEnabled] = useState(initial?.is_enabled !== false)

  const isHttp = transportType === 'streamable_http' || transportType === 'sse'
  const isStdio = transportType === 'stdio'

  const handleSubmit = () => {
    if (!name.trim()) return

    const input: CreateMcpServerInput = {
      name: name.trim(),
      transport_type: transportType as any,
      auto_connect: autoConnect,
      is_enabled: enabled,
    }

    if (isHttp) {
      input.url = url.trim()
      const validHeaders = headers.filter((h) => h.key.trim() && h.value.trim())
      if (validHeaders.length > 0) {
        input.headers = Object.fromEntries(validHeaders.map((h) => [h.key.trim(), h.value.trim()]))
      }
    }

    if (isStdio) {
      input.command = command.trim()
      input.args = args
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
      const validEnv = envVars.filter((e) => e.key.trim() && e.value.trim())
      if (validEnv.length > 0) {
        input.env = Object.fromEntries(validEnv.map((e) => [e.key.trim(), e.value.trim()]))
      }
    }

    onSave(input)
  }

  const addHeaderRow = () => setHeaders([...headers, { key: '', value: '' }])
  const removeHeaderRow = (idx: number) => setHeaders(headers.filter((_, i) => i !== idx))
  const updateHeader = (idx: number, field: 'key' | 'value', val: string) => {
    const next = [...headers]
    next[idx] = { ...next[idx], [field]: val }
    setHeaders(next)
  }

  const addEnvRow = () => setEnvVars([...envVars, { key: '', value: '' }])
  const removeEnvRow = (idx: number) => setEnvVars(envVars.filter((_, i) => i !== idx))
  const updateEnvVar = (idx: number, field: 'key' | 'value', val: string) => {
    const next = [...envVars]
    next[idx] = { ...next[idx], [field]: val }
    setEnvVars(next)
  }

  return (
    <div className={styles.form}>
      <FormField label={t('mcp.name')}>
        <TextInput
          value={name}
          onChange={setName}
          placeholder={t('mcp.namePlaceholder')}
        />
      </FormField>

      <FormField label={t('mcp.transport')}>
        <Select value={transportType} onChange={setTransportType} options={transportOptions} />
      </FormField>

      {isHttp && (
        <>
          <FormField label={t('mcp.url')} hint={t('mcp.urlHint')}>
            <TextInput
              value={url}
              onChange={setUrl}
              placeholder={t('mcp.urlPlaceholder')}
            />
          </FormField>

          <FormField label={t('mcp.headers')} hint={t('mcp.headersHint')}>
            <div className={formStyles.kvList}>
              {headers.map((row, idx) => (
                <div key={idx} className={formStyles.kvRow}>
                  <TextInput
                    value={row.key}
                    onChange={(value) => updateHeader(idx, 'key', value)}
                    placeholder={t('mcp.headerName')}
                  />
                  <TextInput
                    type="password"
                    value={row.value}
                    onChange={(value) => updateHeader(idx, 'value', value)}
                    placeholder={t('mcp.headerValue')}
                  />
                  <button
                    className={formStyles.kvRemove}
                    onClick={() => removeHeaderRow(idx)}
                    type="button"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button className={formStyles.kvAdd} onClick={addHeaderRow} type="button">
                {t('mcp.addHeader')}
              </button>
            </div>
          </FormField>
        </>
      )}

      {isStdio && (
        <>
          <FormField label={t('mcp.command')} hint={t('mcp.commandHint')}>
            <TextInput
              value={command}
              onChange={setCommand}
              placeholder={t('mcp.commandPlaceholder')}
            />
          </FormField>

          <FormField label={t('mcp.args')} hint={t('mcp.argsHint')}>
            <TextInput
              value={args}
              onChange={setArgs}
              placeholder={t('mcp.argsPlaceholder')}
            />
          </FormField>

          <FormField label={t('mcp.env')} hint={t('mcp.envHint')}>
            <div className={formStyles.kvList}>
              {envVars.map((row, idx) => (
                <div key={idx} className={formStyles.kvRow}>
                  <TextInput
                    value={row.key}
                    onChange={(value) => updateEnvVar(idx, 'key', value)}
                    placeholder={t('mcp.varName')}
                  />
                  <TextInput
                    type="password"
                    value={row.value}
                    onChange={(value) => updateEnvVar(idx, 'value', value)}
                    placeholder={t('mcp.headerValue')}
                  />
                  <button
                    className={formStyles.kvRemove}
                    onClick={() => removeEnvRow(idx)}
                    type="button"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button className={formStyles.kvAdd} onClick={addEnvRow} type="button">
                {t('mcp.addVariable')}
              </button>
            </div>
          </FormField>
        </>
      )}

      <Toggle.Checkbox
        checked={autoConnect}
        onChange={setAutoConnect}
        label={t('mcp.autoConnect')}
      />

      <Toggle.Checkbox
        checked={enabled}
        onChange={setEnabled}
        label={t('mcp.enabled')}
      />

      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onCancel}>{tc('actions.cancel')}</Button>
        <Button onClick={handleSubmit} disabled={!name.trim()}>{tc('actions.save')}</Button>
      </div>
    </div>
  )
}
