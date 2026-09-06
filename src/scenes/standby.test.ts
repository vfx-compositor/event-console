// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createInitialState, deserialize, reducer, serialize } from '../state';
import { toHTML } from '../vdom';
import { ATHLETE_OATH_IMAGE, view } from './standby';

describe('기본 대기 화면', () => {
  it('light·dark 대기 영상과 사진 슬롯을 항상 함께 렌더한다 (크로스디졸브용 고정 HTML)', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toContain('class="scene scene--standby-video"');
    expect(html).toContain('class="photo-stage photo-backdrop"');
    expect(html).toContain('data-photo-slot=""');
    expect(html).not.toMatch(/src="[^\"]*\.webm"/);
    expect(html).toContain('poster="./media/standby-light.svg"');
    expect(html).toContain('poster="./media/standby-dark.svg"');
    expect(html).toContain('data-standby-video="light"');
    expect(html).toContain('data-standby-video="dark"');
    // 밝은 영상은 OFF 스택에, 사진 백드롭과 알파 영상은 ON 스택 안에 함께 들어간다.
    // 백드롭이 스택 밖으로 나가면 따로 페이드돼 디졸브 중간에 밝기가 꺼진다.
    expect(html).toContain('data-standby-stack="off"');
    expect(html).toContain('data-standby-stack="on"');
    expect(html).toMatch(
      /data-standby-stack="off"[^>]*>\s*<video[^>]*data-standby-video="light"[^>]*>\s*<\/video>\s*<\/div>/,
    );
    expect(html).toMatch(
      /data-standby-stack="on"[^>]*>\s*<div[^>]*photo-backdrop[\s\S]*?data-standby-video="dark"/,
    );
    // ON 스택이 나중에 와야 위에 깔린다 (인커밍이 위에서 내려와야 dip이 없다)
    expect(html.indexOf('data-standby-stack="off"')).toBeLessThan(
      html.indexOf('data-standby-stack="on"'),
    );
    expect(html).toMatch(/<video[^>]*autoplay[^>]*loop[^>]*muted[^>]*playsinline/);
    expect(html).not.toContain('main_standby.jpeg');
    expect(html).not.toMatch(/data-kv-asset|kv__glow|kv__sweep|kv__emblem|kv__center|kv__title|kv__rule|kv__sub/);
    expect(html).not.toContain(createInitialState().settings.title);
    expect(html).not.toContain(createInitialState().settings.subtitle);
  });

  it('사진 배경 토글은 HTML을 바꾸지 않는다 — stage 재생성 없이 opacity만 넘어간다', () => {
    const off = createInitialState();
    const on = createInitialState();
    on.photos.settings.standbyBackdrop = true;
    expect(toHTML(view(on))).toBe(toHTML(view(off)));
  });

  it('사전미션 cue에서는 지정 JPEG 한 장만 풀프레임으로 렌더한다', () => {
    const state = createInitialState();
    (state.sceneOpts as typeof state.sceneOpts & { standby: { mode: string } }).standby = {
      mode: 'pre-mission',
    };
    state.photos.settings.standbyBackdrop = true;
    const html = toHTML(view(state));
    expect(html).toContain('class="scene scene--standby-image-only"');
    expect(html).toContain('class="pre-mission-image"');
    expect(html).toContain('src="./media/pre_mission.svg"');
    expect(html).not.toMatch(/<video|photo-stage|photo-backdrop|data-photo-slot/);
  });

  it('일반 standby 선택은 stale 사전미션 모드를 닫되 명시적 사전미션 opts는 보존한다', () => {
    let state = createInitialState();
    state.sceneOpts.standby.mode = 'pre-mission';
    state = reducer(state, { type: 'scene/set', scene: 'standby' });
    expect(state.sceneOpts.standby.mode).toBe('main');
    state = reducer(state, {
      type: 'scene/set',
      scene: 'standby',
      opts: { standby: { mode: 'pre-mission' } },
    });
    expect(state.sceneOpts.standby.mode).toBe('pre-mission');
  });
});

/**
 * U60 — 개회식 다음에 세우는 선수 선서 안내 화면.
 * 사전미션과 같은 "이미지 한 장" 계약이되, 파일이 없을 때 검정이 나가면 안 된다.
 */
describe('선수 선서 화면 (U60)', () => {
  function oathState() {
    return reducer(createInitialState(), {
      type: 'scene/set',
      scene: 'standby',
      opts: { standby: { mode: 'oath' } },
    });
  }

  it('지정 이미지 한 장을 풀프레임으로 렌더한다', () => {
    const state = oathState();
    state.photos.settings.standbyBackdrop = true;
    const html = toHTML(view(state));
    expect(state.sceneOpts.standby.mode).toBe('oath');
    expect(html).toContain('scene--standby-image-only');
    expect(html).toContain('scene--oath');
    expect(html).toContain(`src="${ATHLETE_OATH_IMAGE}"`);
    expect(ATHLETE_OATH_IMAGE).toBe('./media/athlete_oath.svg');
    // 대기 영상·사진 슬롯이 섞이면 안 된다 (사전미션과 같은 계약)
    expect(html).not.toMatch(/<video|photo-stage|photo-backdrop|data-photo-slot|standby-stack/);
    expect(html).not.toContain('pre_mission.svg');
  });

  it('이미지가 없어도 검은 화면 대신 타이포 카드가 남는다', () => {
    const html = toHTML(view(oathState()));
    // onerror가 프레임에 is-missing을 붙여 깨진 이미지를 지운다
    expect(html).toContain('onerror=');
    expect(html).toContain('is-missing');
    // 폴백 카드는 조건 없이 항상 마크업에 있다 — 인라인 핸들러가 막혀도 뒤에 깔려 보인다
    expect(html).toContain('oath-fallback');
    expect(html).toContain('선수 선서');
    expect(html).toContain('EVENT CONSOLE');
  });

  it('JS가 붙이는 클래스에 대응 CSS 규칙이 있다', () => {
    const css = readFileSync(new URL('../styles/display.css', import.meta.url), 'utf8');
    for (const name of [
      'scene--oath',
      'oath-frame',
      'oath-image',
      'oath-fallback',
      'oath-fallback__title',
      'oath-fallback__rule',
      'oath-fallback__edition',
    ]) {
      expect(css).toContain(`.${name}`);
    }
    // 폴백 카드는 이미지가 로드되면 가려져야 한다 (겹쳐 보이면 안 된다)
    expect(css).toMatch(/\.oath-frame\.is-missing \.oath-image\s*\{[^}]*display:\s*none/s);
  });

  it('저장본을 왕복해도 선서 모드가 살아남는다', () => {
    const back = deserialize(serialize(oathState()));
    expect(back.sceneOpts.standby.mode).toBe('oath');
  });

  it('알 수 없는 대기 모드는 메인 대기로 접힌다', () => {
    const state = createInitialState();
    (state.sceneOpts.standby as { mode: string }).mode = 'someday';
    expect(deserialize(serialize(state)).sceneOpts.standby.mode).toBe('main');
  });
});
