interface FrontendExtensionAvailability {
  id?: unknown
  identifier?: unknown
  enabled?: unknown
  has_frontend?: unknown
}

function isEnabledFrontendExtension(extension: FrontendExtensionAvailability): boolean {
  return extension.enabled === true && extension.has_frontend === true
}

/** True only while the named extension frontend is installed and available to mount. */
export function hasEnabledFrontendExtension(
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
  identifier: string,
): boolean {
  return Boolean(extensions?.some((extension) => (
    extension.identifier === identifier
    && isEnabledFrontendExtension(extension)
  )))
}

/** True only while the extension that owns a frontend contribution can run. */
export function hasEnabledFrontendExtensionId(
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
  extensionId: string,
): boolean {
  return Boolean(extensions?.some((extension) => (
    extension.id === extensionId && isEnabledFrontendExtension(extension)
  )))
}

/** Remove stale contributions whose owning frontend is disabled or unavailable. */
export function filterEnabledFrontendContributions<T extends { extensionId: string }>(
  contributions: readonly T[],
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
): T[] {
  const enabledIds = new Set(
    extensions
      ?.filter(isEnabledFrontendExtension)
      .map((extension) => extension.id)
      .filter((id): id is string => typeof id === 'string')
      ?? [],
  )
  return contributions.filter((contribution) => enabledIds.has(contribution.extensionId))
}
