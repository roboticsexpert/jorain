import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Milestone } from '../api/types';
import { useReconnect, useSse } from '../live';

/** Milestones of one project (all of them, in order), kept current from `milestone.*` events. Empty slug = none. */
export function useMilestones(slug: string | null | undefined) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);

  const load = useCallback(async () => {
    if (!slug) return setMilestones([]);
    try {
      setMilestones(await api.milestones(slug));
    } catch {
      setMilestones([]);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  useReconnect(load);
  useSse((type, data) => {
    if (type === 'milestone.updated') {
      const m = data as Milestone;
      if (m.project_slug !== slug) return;
      setMilestones((ms) =>
        (ms.some((x) => x.id === m.id) ? ms.map((x) => (x.id === m.id ? m : x)) : [...ms, m]).sort((a, b) => a.position - b.position),
      );
    }
    if (type === 'milestone.deleted') {
      const { id } = data as { id: string };
      setMilestones((ms) => ms.filter((x) => x.id !== id));
    }
  });

  return { milestones, setMilestones, reload: load };
}
