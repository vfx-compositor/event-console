/**
 * 대본이 못 박은 **영상 아웃트로** (U87).
 *
 * ## 왜 필요한가
 * 올림픽 인트로(`olympic_intro_v001.mp4`)는 플레이타임이 다하면 그냥 끝난다 — 소리가 뚝 끊기고
 * (`holding` 단계의 `setGain(track, 0)`), 마지막 프레임이 그대로 얼어붙는다. 방송에 나가면
 * 사고처럼 보인다. 대본상 이 자리의 마무리는 정해져 있다: **끝 5초 동안 소리를 내리면서 화이트로
 * 덮고, 다 덮인 뒤 대기 화면으로 페이드인**한다. 운영자가 매번 고를 값이 아니다.
 *
 * ## 왜 manifest 필드가 아니라 상수표인가
 * `syncMediaManifest`는 재적재 때 사람이 고쳤을 수 있는 값을 지키려고 기존 저장본을 manifest보다
 * **우선**한다. manifest에 `outro`를 넣으면 이 결정 이전에 저장된 브라우저에서는 영영 반영되지
 * 않는다. 진행 대본이 정한 연출은 앱이 알고 있어야 하는 값이므로 `FORCED_CUE_AFTER`와 같은
 * 방식으로 파일 이름을 키로 여기 못 박는다 — 저장본이 아무리 낡아도 항상 걸린다.
 *
 * ## 이 표가 정하는 것
 *  1) 꼬리 페이드 길이·색 (`fadeSec`·`color`) — display가 `duration − fadeSec`에서 꼬리에 들어가
 *     불투명도와 **오디오 게인을 같은 곡선 하나**로 움직인다(`fade.ts` 계약).
 *  2) 걷힌 뒤 갈 씬 (`nextScene`)과 걷는 데 걸리는 시간 (`revealSec`).
 *  3) 이 영상이 `holdEndFrame`을 무시한다는 사실 — 아웃트로가 끝을 책임지므로 마지막 프레임을
 *     붙잡으면 꼬리 페이드가 영영 시작되지 않는다.
 *  4) 큐시트 경계에 **고정으로 보여 줄 전환 방식** (`boundaryMode`) — 운영자가 못 바꾼다.
 */

import { mediaFileFromId } from './media-manifest';
import type { SceneId, SceneTransitionMode } from './types';

/** 영상 뒤에 붙는 검정 대신 쓰는 기본 페이드 색 (일반 영상) */
export const FADE_BASE_COLOR = '#000000';

export interface ScriptedOutro {
  /** 대상 파일 이름 (`media:` 접두사 없는 manifest의 `file`) */
  file: string;
  /** 꼬리 페이드 = 오디오 페이드 아웃 길이(초). `duration − fadeSec`에서 시작한다 */
  fadeSec: number;
  /** 덮는 색 */
  color: string;
  /** 다 덮인 뒤 갈 씬 */
  nextScene: SceneId;
  /** 그 씬을 드러내는 페이드 인 길이(초) */
  revealSec: number;
  /** 큐 경계에 고정 표시할 전환 방식 (운영자 선택 불가) */
  boundaryMode: SceneTransitionMode;
  /** 큐시트 경계 툴팁 — 왜 못 누르는지 그 자리에서 답한다 */
  tip: string;
}

/**
 * 파일 이름 → 아웃트로.
 *
 * 5초는 사용자 지시값이다(2026-09-04 밤). 페이드 인 2초는 그 뒤 대기 화면이 **떠오르는** 길이다 —
 * 전역 `fadeSec`(0.5초)을 그대로 쓰면 5초에 걸쳐 하얘진 화면이 반 박자에 툭 걷혀, 느리게 닫고
 * 빠르게 여는 비대칭이 컷처럼 보인다.
 */
const SCRIPTED_OUTRO: Record<string, ScriptedOutro> = {
  'olympic_intro_v001.mp4': {
    file: 'olympic_intro_v001.mp4',
    fadeSec: 5,
    color: '#ffffff',
    nextScene: 'standby',
    revealSec: 2,
    boundaryMode: 'white',
    tip: '대본 고정 전환 — 올림픽 인트로는 5초 오디오 페이드 뒤 화이트로 대기화면 복귀',
  },
};

/** 상태에 실려 다니는 아웃트로 런타임 값 (직렬화 대상 — 표 전체가 아니라 이 셋만 방송한다) */
export interface VideoOutro {
  fadeSec: number;
  color: string;
  revealSec: number;
}

export function outroRuntime(outro: ScriptedOutro): VideoOutro {
  return { fadeSec: outro.fadeSec, color: outro.color, revealSec: outro.revealSec };
}

/** manifest 파일 이름으로 찾는다 */
export function scriptedOutroForFile(file: string | null | undefined): ScriptedOutro | null {
  if (!file) return null;
  return SCRIPTED_OUTRO[file] ?? null;
}

/** 에셋 id(`media:<file>`)로 찾는다 */
export function scriptedOutroForAsset(assetId: string | null | undefined): ScriptedOutro | null {
  if (!assetId) return null;
  return scriptedOutroForFile(mediaFileFromId(assetId));
}

/**
 * 큐 항목 id(`video:media:<file>`)로 찾는다.
 *
 * 큐시트 경계 잠금이 이 경로를 쓴다. 접두사를 문자열로 자르는 대신 `video:`만 벗기고 나머지는
 * 에셋 경로에 그대로 넘긴다 — 접두사 규칙이 한 곳(`cue.ts`의 `video:${asset.id}`)에만 있게 한다.
 */
export function scriptedOutroForCueId(cueId: string | null | undefined): ScriptedOutro | null {
  if (!cueId || !cueId.startsWith('video:')) return null;
  return scriptedOutroForAsset(cueId.slice('video:'.length));
}

/** 아웃트로가 붙은 파일들 — 에셋 탭의 `holdEndFrame` 토글이 무의미해지는 자리 */
export const SCRIPTED_OUTRO_FILES: ReadonlySet<string> = new Set(Object.keys(SCRIPTED_OUTRO));

/**
 * 저장본 복원 — 모양이 맞지 않으면 통째로 버린다(`null` = 일반 검정 꼬리 페이드).
 *
 * 부분 복구를 하지 않는 이유: 길이만 살아남고 색이 죽으면 5초에 걸쳐 **검정으로** 덮는, 대본에도
 * 없고 아무도 고르지 않은 연출이 방송에 나간다. 값이 깨졌으면 다음 재생이 상수표에서 다시 채운다.
 */
export function normalizeVideoOutro(raw: unknown): VideoOutro | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const { fadeSec, color, revealSec } = rec;
  if (typeof fadeSec !== 'number' || !Number.isFinite(fadeSec) || fadeSec < 0) return null;
  if (typeof revealSec !== 'number' || !Number.isFinite(revealSec) || revealSec < 0) return null;
  if (typeof color !== 'string' || !color.trim()) return null;
  return { fadeSec, color, revealSec };
}
