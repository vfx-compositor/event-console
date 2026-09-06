import { TEAM_IDS, type CurlingBracket, type CurlingMatchId, type RankMap, type TeamId } from './types';

const emptyMatch = () => ({ teams: [null, null] as [TeamId | null, TeamId | null], winner: null });

export function createCurlingBracket(): CurlingBracket {
  return {
    semi1: emptyMatch(),
    semi2: emptyMatch(),
    bronze: emptyMatch(),
    final: emptyMatch(),
  };
}

function loserOf(teams: [TeamId | null, TeamId | null], winner: TeamId | null): TeamId | null {
  if (!winner || !teams.includes(winner)) return null;
  return teams.find((team) => team !== winner) ?? null;
}

function rebuildFinals(bracket: CurlingBracket): CurlingBracket {
  const finalTeams: [TeamId | null, TeamId | null] = [bracket.semi1.winner, bracket.semi2.winner];
  const bronzeTeams: [TeamId | null, TeamId | null] = [
    loserOf(bracket.semi1.teams, bracket.semi1.winner),
    loserOf(bracket.semi2.teams, bracket.semi2.winner),
  ];
  return {
    ...bracket,
    final: {
      teams: finalTeams,
      winner: finalTeams.includes(bracket.final.winner) ? bracket.final.winner : null,
    },
    bronze: {
      teams: bronzeTeams,
      winner: bronzeTeams.includes(bracket.bronze.winner) ? bracket.bronze.winner : null,
    },
  };
}

export function setCurlingPair(
  bracket: CurlingBracket,
  matchId: 'semi1' | 'semi2',
  teams: [TeamId | null, TeamId | null],
): CurlingBracket {
  const uniqueTeams: [TeamId | null, TeamId | null] =
    teams[0] && teams[0] === teams[1] ? [teams[0], null] : teams;
  const current = bracket[matchId];
  const next = {
    ...bracket,
    [matchId]: {
      teams: uniqueTeams,
      winner: uniqueTeams.includes(current.winner) ? current.winner : null,
    },
  };
  return rebuildFinals(next);
}

export function setCurlingWinner(
  bracket: CurlingBracket,
  matchId: CurlingMatchId,
  winner: TeamId | null,
): CurlingBracket {
  const match = bracket[matchId];
  const validWinner = winner && match.teams.includes(winner) ? winner : null;
  const next = { ...bracket, [matchId]: { ...match, winner: validWinner } };
  return matchId === 'semi1' || matchId === 'semi2' ? rebuildFinals(next) : next;
}

export function curlingRanks(bracket: CurlingBracket): RankMap {
  const ranks = {} as RankMap;
  for (const id of TEAM_IDS) ranks[id] = null;
  const first = bracket.final.winner;
  const second = loserOf(bracket.final.teams, first);
  const third = bracket.bronze.winner;
  const fourth = loserOf(bracket.bronze.teams, third);
  if (first) ranks[first] = 1;
  if (second) ranks[second] = 2;
  if (third) ranks[third] = 3;
  if (fourth) ranks[fourth] = 4;
  return ranks;
}

export function ranksFromHigherValues(
  values: Record<TeamId, number | null>,
  activeIds: TeamId[],
): RankMap {
  const ranks = {} as RankMap;
  for (const id of TEAM_IDS) ranks[id] = null;
  const entered = activeIds
    .filter((id) => values[id] !== null)
    .sort((a, b) => (values[b] as number) - (values[a] as number));
  for (const id of entered) {
    const value = values[id] as number;
    ranks[id] = 1 + entered.filter((other) => (values[other] as number) > value).length;
  }
  return ranks;
}
