/**
 * 2부 단계 — **남은 시간 수기 입력** (U135, 사용자 지시 14:53).
 *
 * 사용자 원문: "점수 입력방식을 남은시간으로 순위를 매기게 해달라는 이야기야. 많이 남은팀이
 * 승리. 지금이랑 로직은 같은데 수기입력을 허용해달라는 것."
 *
 * ## 왜 순위 함수를 안 건드리는가
 * "로직은 같다"를 문자 그대로 지킨다. `rankSubmissions`는 정답 제출을 `at` **오름차순**으로
 * 정렬하고 선두로부터 `tieWindowSec` 이내를 공동 순위로 묶는다. 남은 시간을
 * `at = -remainingSec * 1000`으로 사상하면:
 *
 *  - 많이 남은 팀일수록 `at`이 **작아져** 먼저 정렬된다 → "많이 남은 팀이 승리".
 *  - 두 팀의 `at` 차이 = 남은 시간 차 × 1000ms → tieWindow 비교가 "선두와 N초 이내"에서
 *    "남은 시간 차가 N초 이내"로 **의미만 갈아 끼운 채** 그대로 성립한다.
 *
 * 그래서 `rankSubmissions` · `pointsFromRanks` · `p2/confirm` 경로는 한 줄도 바뀌지 않는다
 * (원장 append-only 계약과 역분개 경로도 그대로).
 *
 * ## 혼용 주의
 * `at`이 음수(수기)와 양수(epoch 시각)로 섞이면 수기 팀이 **항상** 앞선다. 한 단계 안에서는
 * 한 방식만 쓰는 것이 운영 규칙이고, UI는 경고만 띄운다 — 코드로 막으면 현장에서 잘못 누른
 * 기록을 되돌릴 방법이 줄어든다.
 */

/** 남은 시간(초) → `Submission.at`에 넣을 값. 음수라 시각 제출보다 항상 앞선다. */
export function remainingToAt(remainingSec: number): number {
  return -remainingSec * 1000;
}

/** `at` 값에서 남은 시간(초)을 되돌린다. `remainingSec`이 없는 옛 기록 보정용. */
export function atToRemaining(at: number): number {
  return -at / 1000;
}

const COLON_PART = /^\d+(\.\d+)?$/;
/** "7분", "7분 30초", "90초" — 진행자가 스톱워치를 보고 손으로 적는 실제 표기. */
const KO_UNITS = /^(?:(\d+(?:\.\d+)?)\s*분)?\s*(?:(\d+(?:\.\d+)?)\s*초)?$/;

/**
 * 수기 입력 문자열 → 남은 시간(초). 못 읽으면 `null`.
 *
 * 받는 표기 (현장에서 실제로 치는 것들):
 *  - `"12:34"` → 754 · `"1:02:03"` → 3723 (콜론은 60진법, 2~3칸)
 *  - `"90"` → 90 (**단위 없는 숫자는 초**)
 *  - `"7분"` → 420 · `"7분 30초"` → 450 · `"90초"` → 90
 *
 * 0은 유효하다(남은 시간 0 = 시간을 다 쓴 팀). 음수·빈 값·해석 불가는 `null`이고, 호출부는
 * `null`이면 아무것도 기록하지 않는다 — 원장에 잘못된 순위가 들어가는 것보다 낫다.
 */
export function parseRemaining(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;

  if (t.includes(':')) {
    const parts = t.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    let total = 0;
    for (const p of parts) {
      const s = p.trim();
      if (!COLON_PART.test(s)) return null;
      total = total * 60 + Number(s);
    }
    return Number.isFinite(total) ? total : null;
  }

  const ko = KO_UNITS.exec(t);
  if (ko && (ko[1] !== undefined || ko[2] !== undefined)) {
    const sec = (ko[1] ? Number(ko[1]) * 60 : 0) + (ko[2] ? Number(ko[2]) : 0);
    return Number.isFinite(sec) ? sec : null;
  }

  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 남은 시간(초) → `m:ss`. 표시 전용이라 반올림한다(입력은 소수도 허용). */
export function fmtRemaining(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
