import { registerHostSurfaceRenderer } from './host-surface-registry'
import {
  PRODUCTIVITY_HOST_SURFACES,
  ProductivityHostSurfaceRenderer,
} from './productivity-host-contracts'

for (const surfaceId of PRODUCTIVITY_HOST_SURFACES) {
  registerHostSurfaceRenderer(surfaceId, (props, context) => (
    <ProductivityHostSurfaceRenderer surfaceId={surfaceId} props={props} context={context} />
  ))
}
