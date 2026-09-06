import type { Action } from '../state';
import type { DirState } from '../photo-intake';
import type { DuckedCue } from '../music-duck';
import type { RenderHoldOwner } from './render-hold';
import type { MusicProgress } from '../sync';
import type { AppState } from '../types';

export interface StatusInfo {
  /** 출력 창이 붙어 있는지 (최근 hello 수신) */
  displayConnected: boolean;
  /** 카메라 사용 가능 여부. null = 아직 확인 안 됨 */
  cameraOk: boolean | null;
  /** 마지막 저장 시각 (epoch ms) */
  savedAt: number;
  /** 마지막 저장 실패 사유 (null이면 정상). 용량 초과 등을 화면에 드러내기 위한 것 */
  saveError: string | null;
  /**
   * 출력 창의 오디오가 브라우저 자동재생 정책에 막혀 있는가.
   * `null`/`undefined` = 출력 창이 아직 보고하지 않음(`cameraOk`와 같은 관례).
   * 값 세팅은 `control.ts`가 한다.
   * 출력 창은 원래 조작하지 않는 창이라 리허설에서 놓치기 쉬워 상단에 상시 노출한다.
   */
  audioLocked?: boolean | null;
  /**
   * 출력 창에서 **운영자가 음소거 버튼을 눌러** 소리가 나가지 않는가 (U88).
   *
   * `null`/`undefined` = 출력 창이 아직 보고하지 않음(`audioLocked`와 같은 관례).
   * 값 세팅은 `control.ts`가 한다.
   *
   * `audioLocked`와 별도 필드인 이유: 자동재생 잠금은 고쳐야 할 사고고 이쪽은 운영자가
   * 누른 상태다. 한 필드로 합치면 잠금 배너의 `critical` 판정이 음소거에도 걸려,
   * 고칠 것 없는 빨강이 상시로 떠 진짜 잠금을 가린다.
   */
  displayUserMuted?: boolean | null;
  /**
   * 사진 폴더의 File System Access 권한 상태 (계획 §10 위험 R1).
   *
   * `null`/`undefined` = 리더가 아직 확인하지 않음(`cameraOk`·`audioLocked`와 같은 관례).
   * **값 세팅은 `control.ts`가 한다** — `restorePhotoDir()`·`pickPhotoDir()`·`regrantPhotoDir()`
   * 의 결과를 그대로 옮겨 담고, 비리더 창에서는 건드리지 않는다.
   *
   * 왜 상단 바까지 올라오는가: 브라우저를 재시작하면 폴더 권한이 조용히 `'prompt'`로
   * 돌아간다. 자동 수집이 켜져 있는데 권한이 없으면 **아무 일도 일어나지 않는** 형태로
   * 사고가 나서 현장에서 알아채지 못한다. 포토 탭을 열지 않아도 보이도록
   * 출력 소리 점과 같은 컴포넌트·같은 자리에 경고 점을 띄운다.
   */
  photoDir?: DirState | null;
  /** display가 200ms 간격으로 보고한 BGM 재생 위치. 상태 원장에는 쓰지 않는다. */
  musicProgress?: MusicProgress & { at: number };
  /**
   * display가 1초마다 보고한 슬로우 리플레이 버퍼 길이(초) (Q5).
   *
   * 상태가 아니라 순간 값이다 — 매초 원장에 쓰면 persist·방송이 쉬지 않고 돈다.
   * `cameraOk`·`audioLocked`와 같은 관례로 값 세팅은 `control.ts`가 한다.
   */
  replayBufferSec?: number;
}

export interface Ctx {
  readonly state: AppState;
  dispatch(action: Action | Action[]): void;
  /** 재렌더만 필요할 때 (로컬 UI 상태 변경) */
  refresh(): void;
  /**
   * 포인터를 잡고 있는 동안 재렌더를 미룬다 (U43, 소유자 집합은 U104 리뷰 m2/m4).
   *
   * `render()`는 트리를 통째로 새로 만들기 때문에, 드래그 중에 재렌더가 돌면 포인터를
   * 붙잡고 있던 엘리먼트가 교체되며 드래그가 그 자리에서 끊긴다. `true`로 잡고
   * `false`로 놓으면 미뤄 둔 재렌더가 그때 한 번 나간다. 상태·persist·출력 창 방송은
   * 잡고 있는 동안에도 평소대로 흐른다 — 멈추는 것은 DOM뿐이다.
   *
   * `owner`는 **누가** 잡았는지를 구분한다 — 볼륨 슬라이더를 잡고 있어도 음악 슬라이더의
   * 라이브 갱신이 같이 얼어붙지 않고(m2), 두 슬라이더를 동시에 잡은 채 한쪽만 놓아도
   * 다른 쪽이 여전히 재렌더를 보류시킨다(m4). `render-hold.ts`의 `RenderHold.owners`가
   * 실제 상태를 들고, 여기는 그 소유자 이름표만 넘긴다.
   */
  holdRender(owner: RenderHoldOwner, on: boolean): void;
  /**
   * 음악이 내려가는 동안 붙잡아 둔 큐 (U44). `null`이면 대기 중인 큐가 없다.
   * 예약은 이 창의 타이머일 뿐 상태가 아니다 — 리더가 바뀌면 폐기된다.
   */
  readonly duckedCue: DuckedCue | null;
  /** `musicDuckSec` 뒤에 `run()`을 실행하도록 예약한다. 이미 예약이 있으면 그것을 버린다. */
  deferCue(cueIndex: number, run: () => void): void;
  /** 예약을 취소하고 음악을 되돌린다 (칩의 [취소] · 리더 인수 · 다른 조작). */
  cancelDeferredCue(): void;
  status: StatusInfo;
  /** 현재 활성 탭 id */
  tab: string;
  setTab(id: string): void;
  /** 영상 재생 제어 (control → display 는 상태 경유이므로 씬 전환으로 표현) */
  playAsset(assetId: string, nextScene: AppState['scene'] | null): void;
  /**
   * 슬로우 리플레이 토글 (Q5). 재생 중이 아니면 시작, 재생 중이면 라이브로 복귀한다.
   * 버튼과 단축키 `R`이 **같은 함수**를 쓴다 — 두 경로가 다른 조건으로 갈리지 않게.
   */
  toggleReplay(): void;
  /**
   * [지금부터] 반쪽 (U85). 재생 중이면 정지, 찍어 둔 구간이 없으면 지금을 찍고,
   * 있으면 그 구간을 튼다. 버튼 오른쪽 절반과 단축키 `Shift+R`이 **같은 함수**를 쓴다.
   */
  toggleReplayMark(): void;
  /** 찍어 둔 구간 취소 (U85 — [지금부터] Shift+클릭) */
  clearReplayMark(): void;
  /** 에셋 목록 재조회 */
  reloadAssets(): void;
  /** `media/manifest.json` 을 다시 읽어 빠진 기본 영상을 등록한다 */
  reloadMedia(opts?: { manual?: boolean }): void;
}
