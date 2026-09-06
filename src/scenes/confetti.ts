/** 컨페티 — canvas 파티클. 외부 라이브러리 없음. */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
}

// 골드/화이트 위주 — 팀 컬러는 소량만 섞어 화면 전체가 알록달록해지지 않게 한다.
// (방송 그래픽 안티패턴 "다색 칩 남발"과 같은 이유: 액센트 1색 + 무채가 기본)
const COLORS = ['#e8b94c', '#f2d089', '#ffffff', '#e8b94c', '#dfe5ee', '#ffffff', '#e8b94c', '#c0453b'];

export class Confetti {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private particles: Particle[] = [];
  private raf = 0;
  private last = 0;

  constructor(width = 1920, height = 1080) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.className = 'confetti-canvas';
    this.ctx = this.canvas.getContext('2d');
  }

  private spawn(n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: -20 - Math.random() * 400,
        vx: (Math.random() - 0.5) * 120,
        vy: 180 + Math.random() * 260,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 8,
        w: 10 + Math.random() * 14,
        h: 6 + Math.random() * 10,
        color: COLORS[(Math.random() * COLORS.length) | 0],
      });
    }
  }

  start(): void {
    if (this.raf) return;
    this.particles = [];
    this.spawn(280);
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.particles = [];
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private step(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const p of this.particles) {
      p.vy += 220 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > this.canvas.height + 40) {
        // 계속 흩날리도록 상단에서 재투입
        p.y = -30;
        p.x = Math.random() * this.canvas.width;
        p.vy = 160 + Math.random() * 220;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
  }
}
