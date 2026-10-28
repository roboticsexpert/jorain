import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Group, Project } from '../api/types';
import { useReconnect, useSse } from '../live';

/** All groups, sorted by name, kept current from `group.*` events. */
export function useGroups() {
  const [groups, setGroups] = useState<Group[]>([]);

  const load = useCallback(async () => {
    try {
      setGroups(sortGroups(await api.groups()));
    } catch {
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useReconnect(load);
  useSse((type, data) => {
    if (type === 'group.updated') setGroups((gs) => upsertGroup(gs, data as Group));
    if (type === 'group.deleted') setGroups((gs) => gs.filter((g) => g.slug !== (data as { slug: string }).slug));
  });

  return { groups, setGroups, reload: load };
}

export const sortGroups = (gs: Group[]) => gs.slice().sort((a, b) => a.name.localeCompare(b.name));

export const upsertGroup = (gs: Group[], g: Group) => sortGroups(gs.some((x) => x.slug === g.slug) ? gs.map((x) => (x.slug === g.slug ? g : x)) : [...gs, g]);

/** The group a project belongs to (by the group's member list). */
export const groupOf = (groups: Group[], projectSlug: string) => groups.find((g) => g.projects.includes(projectSlug));

/** "Shop (backend + frontend)": the group name with its members' names. */
export function groupLabel(g: Group, projects: Project[]) {
  const names = g.projects.map((s) => projects.find((p) => p.slug === s)?.name ?? s);
  return names.length ? `${g.name} (${names.join(' + ')})` : g.name;
}
