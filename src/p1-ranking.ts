export interface RankChoice {
  rank: number | null;
  label: string;
  pressed: boolean;
}

export function rankChoices(teamCount: number, selected: number | null): RankChoice[] {
  return [
    { rank: null, label: '미정', pressed: selected === null },
    ...Array.from({ length: teamCount }, (_, index) => {
      const rank = index + 1;
      return { rank, label: `${rank}위`, pressed: selected === rank };
    }),
  ];
}
