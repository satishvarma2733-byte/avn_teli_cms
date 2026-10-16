import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/primitives';

import type { DocView } from './types';

/** Where a file is in its journey: being checked, ready, or blocked. */
export function DocStateBadge({ doc }: { doc: Pick<DocView, 'state'> }) {
  switch (doc.state) {
    case 'ready':
      return <Badge tone="success">Ready</Badge>;
    case 'blocked':
      return <Badge tone="danger">Blocked</Badge>;
    case 'rejected':
      return <Badge tone="danger">Refused</Badge>;
    default:
      return (
        <Badge tone="info">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Checking
        </Badge>
      );
  }
}
