/**
 * 배경 앰비언트 — 출력 화면에 깔리는 은은한 모션 레이어.
 *
 * 왜 캔버스를 `#stage` 밖(#viewport 자식)에 두는가:
 *   씬 렌더가 stage.innerHTML을 통째로 갈아치우고, `.scene--standby/live/video`는 자기 배경을
 *   **불투명하게** 칠한다. 스테이지 안에 넣으면 매 렌더마다 날아가거나 씬 배경에 덮인다.
 *   그래서 transition.ts와 같은 이유로 스테이지 밖에 붙이고, 같은 기하로 겹쳐
 *   `mix-blend-mode: screen`으로 합성한다 (fitStage가 스테이지와 동일 스케일을 먹인다).
 *
 * 왜 screen 합성인가:
 *   더하기 합성이라 "배경을 어둡게 만드는 사고"가 원천 차단되고, 그리는 알파가 곧
 *   화면에 더해지는 휘도가 된다. 즉 `--ambient-max` 한 값으로 텍스트 대비 하한을 지킬 수 있다.
 *
 * 구현 규칙 (confetti.ts와 같은 톤):
 *   - 라이브러리 없이 canvas 2D만. 레이아웃 속성 애니메이션 금지 → 60fps.
 *   - 파티클·라인·그라디언트·패턴은 **생성 시 1회 할당**해 재사용한다. 매 프레임 new 금지.
 *   - `prefers-reduced-motion: reduce`면 rAF 루프 자체를 돌리지 않고 캔버스를 비운다.
 *   - `document.hidden`이면 루프를 멈추고, 다시 보이면 lastTime을 now로 리셋해 재개한다
 *     (안 그러면 숨어 있던 시간만큼 애니메이션이 점프한다).
 */

import type { SceneId } from '../types';

type AmbientMode = 'standby' | 'track' | 'investigate' | 'off';

/**
 * 씬 → 모드 매핑.
 *   live/video 는 카메라·영상 위라 어떤 덧그리기도 방해가 되고,
 *   award 는 컨페티가 이미 화면을 채우고 있으므로 둘 다 'off'.
 */
const MODE_BY_SCENE: Record<SceneId, AmbientMode> = {
  standby: 'standby',
  game: 'track',
  score: 'track',
  timer: 'track',
  roster: 'track',
  prompt: 'track',
  breaking: 'investigate',
  suspects: 'investigate',
  submit: 'investigate',
  live: 'off',
  video: 'off',
  // 사진이 화면을 가득 채우므로 위에 아무것도 덮지 않는다 (live/video와 같은 이유)
  photos: 'off',
  award: 'off',
};

const W = 1920;
const H = 1080;
const CX = W / 2;
const CY = H / 2;

/** 모드 전환 페이드(초). 즉시 끊으면 씬 전환 스윕이 걷힌 뒤 배경이 톡 튄다. */
const FADE_S = 0.3;

/** `--ambient-max` 파싱 실패 시 폴백 */
const AMBIENT_MAX_FALLBACK = 0.06;

// ── standby ──────────────────────────────────────────────────────────────
const PARTICLE_COUNT = 60;
/** 파티클이 부유하는 중앙 영역 (엠블럼 주변) */
const FIELD_RX = 760;
const FIELD_RY = 430;
/** 광선 1회 통과 시간(초) — 3~4s 사이에서 매번 다시 뽑는다 */
const BEAM_DUR_MIN = 3;
const BEAM_DUR_MAX = 4;
/** 광선 주기(초) — 25~40s. 한 번에 하나만 지나간다. */
const BEAM_GAP_MIN = 25;
const BEAM_GAP_MAX = 40;
const BEAM_W = 560;
const BEAM_ANGLE = -0.36; // rad. 대각선 기울기
const BEAM_TRAVEL = 1900; // 회전축 기준 좌우 이동 폭(px)

// ── track ────────────────────────────────────────────────────────────────
const LINE_COUNT = 7;
/** 골드 라인 호흡 주기(초) — 6~8s 구간 */
const BREATH_S = 7;

// ── investigate ──────────────────────────────────────────────────────────
/** 스캔라인 타일 높이(px). 위 절반만 밝다. */
const SCAN_TILE = 6;
/** 붉은 비네팅 펄스 주기(초) */
const PULSE_S = 6;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 개별 밝기 배수 (0~1) */
  k: number;
  /** 반짝임 위상 */
  ph: number;
}

interface TrackLine {
  y: number;
  /** px/s. 극저속(≤8) */
  v: number;
  h: number;
  k: number;
}

export class Ambient {
  readonly canvas: HTMLCanvasElement;

  private ctx: CanvasRenderingContext2D | null;
  /** 화면에 더할 수 있는 최대 휘도. screen 합성이므로 이 값이 곧 대비 손실 상한이다. */
  private readonly max: number;

  private raf = 0;
  private last = 0;
  /** 루프가 도는 동안에만 흐르는 시계(초). 숨었다 돌아와도 점프하지 않는다. */
  private clock = 0;

  /** 지금 그리고 있는 모드 */
  private mode: AmbientMode = 'off';
  /** 마지막으로 요청된 모드 (setScene이 매 프레임 불려도 여기서 걸러진다) */
  private target: AmbientMode = 'off';
  /** 페이드 아웃이 끝나면 갈아탈 모드 */
  private pending: AmbientMode | null = null;
  /** 전역 알파 배수 0~1 */
  private fade = 0;

  private readonly reduce: MediaQueryList;

  // 재사용 자원 — 전부 생성 시 1회 할당
  private readonly particles: Particle[] = [];
  private readonly lines: TrackLine[] = [];
  private beamGrad: CanvasGradient | null = null;
  private vignetteGrad: CanvasGradient | null = null;
  private scanPattern: CanvasPattern | null = null;
  private readonly fillWhite = 'rgb(255,255,255)';
  private readonly fillAccent: string;
  private readonly fillDanger: string;

  /** 다음 광선이 출발하는 시각(clock 기준, 초) */
  private beamAt = 0;
  private beamDur = BEAM_DUR_MIN;

  constructor() {
    this.canvas = document.createElement('canvas');
    // backing store는 스테이지 논리 해상도 고정. 항상 축소 표시되므로 DPR 보정이 필요 없다.
    this.canvas.width = W;
    this.canvas.height = H;
    this.canvas.id = 'ambient';
    this.ctx = this.canvas.getContext('2d');

    const css = getComputedStyle(document.documentElement);
    this.max = readAlpha(css.getPropertyValue('--ambient-max'), AMBIENT_MAX_FALLBACK);
    this.fillAccent = rgbOf(css.getPropertyValue('--accent'), '232,185,76');
    this.fillDanger = rgbOf(css.getPropertyValue('--danger'), '226,59,59');

    this.seed();
    this.buildPaints();

    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    // 런타임에 설정이 바뀌어도 따라간다 (OS 접근성 토글)
    this.reduce.addEventListener('change', () => this.sync());
    document.addEventListener('visibilitychange', () => this.sync());
  }

  /** 매 프레임 호출된다. 같은 씬이면 여기서 즉시 빠진다. */
  setScene(id: SceneId): void {
    const next = MODE_BY_SCENE[id];
    if (next === this.target) return;
    this.target = next;
    // 페이드 도중 원래 모드로 되돌아오면 전환을 취소하고 그대로 밝아진다
    this.pending = next === this.mode ? null : next;
    this.sync();
  }

  /** 루프를 돌려야 하는 상태인지 다시 판단한다 (모드 변경·가시성·모션 설정 변경 공용) */
  private sync(): void {
    const idle = this.mode === 'off' && this.pending === null;
    if (this.reduce.matches || document.hidden || idle) {
      this.stopLoop();
      if (this.reduce.matches || idle) this.clear();
      return;
    }
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      // 탭 복귀 직후 첫 프레임이 수 초짜리 dt로 들어오는 것을 막는다
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.raf = this.raf ? requestAnimationFrame(loop) : 0;
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private clear(): void {
    this.ctx?.clearRect(0, 0, W, H);
  }

  private step(dt: number): void {
    this.clock += dt;

    if (this.pending) {
      this.fade -= dt / FADE_S;
      if (this.fade <= 0) {
        this.fade = 0;
        this.mode = this.pending;
        this.pending = null;
        // 이전 모드의 잔상이 남지 않게 한 번 비우고 새 모드를 시작한다
        this.clear();
        if (this.mode === 'standby') this.beamAt = this.clock + 6;
      }
    } else if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / FADE_S);
    }

    this.draw(dt);

    if (this.mode === 'off' && this.pending === null) {
      // 그릴 게 없어졌다 — 루프를 접어 GPU/CPU를 아예 놓아준다
      this.stopLoop();
      this.clear();
    }
  }

  private draw(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (this.fade <= 0) return;

    if (this.mode === 'standby') this.drawStandby(ctx, dt);
    else if (this.mode === 'track') this.drawTrack(ctx, dt);
    else if (this.mode === 'investigate') this.drawInvestigate(ctx);
  }

  // ────────────────────────────────────────────────────────── standby

  private drawStandby(ctx: CanvasRenderingContext2D, dt: number): void {
    const t = this.clock;

    // 1) 미세 파티클 — 엠블럼 주변을 아주 느리게 부유한다(≤6px/s)
    ctx.fillStyle = this.fillWhite;
    const pMax = this.max * 0.5 * this.fade;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // 영역을 벗어나면 반대편에서 다시 들어온다 (재할당 없이 좌표만 되돌린다)
      if (p.x < CX - FIELD_RX) p.x = CX + FIELD_RX;
      else if (p.x > CX + FIELD_RX) p.x = CX - FIELD_RX;
      if (p.y < CY - FIELD_RY) p.y = CY + FIELD_RY;
      else if (p.y > CY + FIELD_RY) p.y = CY - FIELD_RY;

      ctx.globalAlpha = pMax * p.k * (0.55 + 0.45 * Math.sin(t * 0.6 + p.ph));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2) 대각 광선 — 한 번에 하나만, 25~40초 주기로 화면을 훑고 지나간다
    if (t >= this.beamAt && this.beamGrad) {
      const p = (t - this.beamAt) / this.beamDur;
      if (p >= 1) {
        this.beamAt = t + BEAM_GAP_MIN + Math.random() * (BEAM_GAP_MAX - BEAM_GAP_MIN);
        this.beamDur = BEAM_DUR_MIN + Math.random() * (BEAM_DUR_MAX - BEAM_DUR_MIN);
      } else {
        // ease-in-out — 가장자리에서 느리고 화면 중앙에서 빠르다
        const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) * (-2 * p + 2)) / 2;
        // 화면 밖에서 시작·끝나지만 알파 봉투로 한 번 더 눌러 팝을 없앤다
        ctx.globalAlpha = this.max * this.fade * Math.min(1, Math.sin(Math.PI * p) * 1.7);
        ctx.save();
        ctx.translate(CX, CY);
        ctx.rotate(BEAM_ANGLE);
        ctx.translate(-BEAM_TRAVEL + e * BEAM_TRAVEL * 2, 0);
        ctx.fillStyle = this.beamGrad;
        ctx.fillRect(-BEAM_W / 2, -1700, BEAM_W, 3400);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ──────────────────────────────────────────────────────────── track

  private drawTrack(ctx: CanvasRenderingContext2D, dt: number): void {
    // 골드 라인 **하나만** 호흡한다. 여러 줄이 같이 뛰면 배경이 아니라 UI로 읽힌다.
    const breath = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((this.clock / BREATH_S) * Math.PI * 2));
    for (let i = 0; i < this.lines.length; i += 1) {
      const l = this.lines[i];
      l.y += l.v * dt;
      if (l.y > H + 2) l.y -= H + 4;
      const gold = i === 0;
      ctx.fillStyle = gold ? this.fillAccent : this.fillWhite;
      ctx.globalAlpha = this.max * this.fade * l.k * (gold ? breath : 1);
      ctx.fillRect(0, l.y, W, l.h);
    }
    ctx.globalAlpha = 1;
  }

  // ─────────────────────────────────────────────────────── investigate

  private drawInvestigate(ctx: CanvasRenderingContext2D): void {
    // 1) 미세 스캔라인 — 패턴은 1회 생성, 스크롤은 transform으로만 준다(재생성 0)
    if (this.scanPattern) {
      const off = (this.clock * 9) % SCAN_TILE;
      ctx.globalAlpha = this.max * this.fade * 0.5;
      ctx.save();
      ctx.translate(0, off);
      ctx.fillStyle = this.scanPattern;
      ctx.fillRect(0, -SCAN_TILE, W, H + SCAN_TILE * 2);
      ctx.restore();
    }

    // 2) 붉은 비네팅 — 6초 주기 펄스. 중앙(텍스트가 사는 곳)은 항상 투명하다.
    if (this.vignetteGrad) {
      const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((this.clock / PULSE_S) * Math.PI * 2));
      ctx.globalAlpha = this.max * this.fade * pulse;
      ctx.fillStyle = this.vignetteGrad;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  // ──────────────────────────────────────────────────────────── 초기화

  private seed(): void {
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random());
      this.particles.push({
        x: CX + Math.cos(a) * FIELD_RX * rad,
        y: CY + Math.sin(a) * FIELD_RY * rad,
        // 속도 상한 6px/s — 시선이 따라가지 않는 속도여야 "배경"으로 읽힌다
        vx: (Math.random() - 0.5) * 12,
        vy: (Math.random() - 0.5) * 8,
        r: 1 + Math.random() * 2.2,
        k: 0.35 + Math.random() * 0.65,
        ph: Math.random() * Math.PI * 2,
      });
    }

    for (let i = 0; i < LINE_COUNT; i += 1) {
      this.lines.push({
        y: (H / LINE_COUNT) * i + Math.random() * 40,
        // 8px/s 상한. index 0 = 골드 라인.
        v: 2 + Math.random() * 6,
        h: i === 0 ? 2 : 1 + (i % 2),
        k: i === 0 ? 1 : 0.18 + Math.random() * 0.22,
      });
    }
  }

  private buildPaints(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // 광선: 회전·이동은 fill 시점의 transform이 그라디언트 좌표까지 같이 옮겨 주므로
    // 로컬 좌표(-W/2 ~ +W/2)로 한 번만 만들어 두면 된다.
    const g = ctx.createLinearGradient(-BEAM_W / 2, 0, BEAM_W / 2, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(0.58, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    this.beamGrad = g;

    const v = ctx.createRadialGradient(CX, CY, 380, CX, CY, 1180);
    v.addColorStop(0, `rgba(${this.fillDangerRgb()},0)`);
    v.addColorStop(0.62, `rgba(${this.fillDangerRgb()},0.35)`);
    v.addColorStop(1, `rgba(${this.fillDangerRgb()},1)`);
    this.vignetteGrad = v;

    // 스캔라인은 1×SCAN_TILE 타일 하나로 만들어 패턴으로 반복한다.
    // 매 프레임 270줄을 fillRect 하는 것보다 싸고, 스크롤도 transform으로 공짜다.
    const tile = document.createElement('canvas');
    tile.width = 1;
    tile.height = SCAN_TILE;
    const tctx = tile.getContext('2d');
    if (tctx) {
      tctx.fillStyle = this.fillWhite;
      tctx.fillRect(0, 0, 1, 2);
      this.scanPattern = ctx.createPattern(tile, 'repeat');
    }
  }

  private fillDangerRgb(): string {
    // 'rgb(r,g,b)' → 'r,g,b'
    return this.fillDanger.slice(4, -1);
  }
}

// ──────────────────────────────────────────────────────────── 토큰 파싱

/** `--ambient-max` 값(0~1 숫자)을 읽는다. 이상값은 폴백으로 되돌린다. */
function readAlpha(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

/** `#rrggbb` / `#rgb` 토큰을 canvas fillStyle용 `rgb(r,g,b)` 문자열로. 실패 시 폴백. */
function rgbOf(raw: string, fallback: string): string {
  const s = raw.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return `rgb(${fallback})`;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = Number.parseInt(hex, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}
