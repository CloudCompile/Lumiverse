export function shouldSyncExtensionsAfterConnected(
  payload: { role?: string } | undefined,
): payload is { role: string } {
  return typeof payload?.role === 'string' && payload.role.length > 0
}
