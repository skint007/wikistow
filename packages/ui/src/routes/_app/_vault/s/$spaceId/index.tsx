import { createFileRoute } from '@tanstack/react-router';
import { Replaceable } from '../../../../../plugins/places';
import { PickAPage } from '../../../../../shell/pick-a-page';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/')({ component: SpaceHome });

/** A space with no page open: Pick a page, unless a plugin draws its home. */
function SpaceHome() {
  const { spaceId } = Route.useParams();
  return (
    <Replaceable name="space.home" inputs={{ spaceId }}>
      <PickAPage />
    </Replaceable>
  );
}
