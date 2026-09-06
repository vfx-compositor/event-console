// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEAM_LOGOS,
  defaultLogoUrl,
  isDefaultTeamLogo,
  logoClass,
  logoUrl,
} from './logos';
import { DEFAULT_TEAM_NAMES } from './state';
import { CONFIRMED_TEAM_COUNT, TEAM_IDS } from './types';

describe('오피셜 팀 배지 기본 로고 (U31)', () => {
  it('확정 4팀 슬롯에만 기본 로고가 있다', () => {
    expect(DEFAULT_TEAM_LOGOS).toHaveLength(CONFIRMED_TEAM_COUNT);
    expect(defaultLogoUrl({ id: 't5' })).toBeUndefined();
    expect(defaultLogoUrl({ id: 't6' })).toBeUndefined();
  });

  it('파일 이름은 슬롯 기본 팀 이름(정본)에서 파생된다', () => {
    // 하드코딩 목록이 아니라 DEFAULT_TEAM_NAMES와 같은 순서·같은 단어여야 한다.
    for (let i = 0; i < CONFIRMED_TEAM_COUNT; i += 1) {
      const color = DEFAULT_TEAM_NAMES[i].toLowerCase();
      expect(DEFAULT_TEAM_LOGOS[i]).toBe(`./media/team_logo_${color}.svg`);
      expect(defaultLogoUrl({ id: TEAM_IDS[i] })).toBe(DEFAULT_TEAM_LOGOS[i]);
    }
    expect(DEFAULT_TEAM_LOGOS).toEqual([
      './media/team_logo_yellow.svg',
      './media/team_logo_blue.svg',
      './media/team_logo_red.svg',
      './media/team_logo_green.svg',
    ]);
  });

  it('업로드가 없으면 슬롯 기본 로고로 떨어진다', () => {
    expect(logoUrl({ id: 't1' })).toBe('./media/team_logo_yellow.svg');
    expect(logoUrl({ id: 't4' })).toBe('./media/team_logo_green.svg');
    // 기본 로고가 없는 슬롯은 예전처럼 이니셜 배지로 남는다
    expect(logoUrl({ id: 't5' })).toBeUndefined();
  });

  it('팀 이름을 바꿔도 슬롯 로고는 그대로다 (로고 교체는 업로드로만)', () => {
    expect(logoUrl({ id: 't2', name: '파랑팀' } as { id: string })).toBe(
      './media/team_logo_blue.svg',
    );
  });

  it('사용자 업로드가 기본 로고를 이긴다', () => {
    expect(logoUrl({ id: 't1', logoDataUrl: 'data:image/png;base64,AAA' })).toBe(
      'data:image/png;base64,AAA',
    );
    // assetId는 IndexedDB에서 풀리기 전까지 undefined — 기본 배지로 깜빡였다 바뀌지 않는다
    expect(logoUrl({ id: 't1', logoAssetId: 'logo_t1_x' })).toBeUndefined();
  });

  it('기본 배지인지 판별해 CSS 훅을 붙인다', () => {
    expect(isDefaultTeamLogo('./media/team_logo_red.svg')).toBe(true);
    expect(isDefaultTeamLogo('blob:https://x/1')).toBe(false);
    expect(isDefaultTeamLogo(undefined)).toBe(false);

    expect(logoClass('luxe-logo', './media/team_logo_red.svg')).toBe('luxe-logo team-badge');
    expect(logoClass('luxe-logo', 'blob:https://x/1')).toBe('luxe-logo');
  });
});

describe('오피셜 배지 표시 계약 (U31)', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('display는 부팅 때 배지 4장과 행사 모노그램을 미리 받아 둔다', () => {
    const display = read('./display.ts');
    expect(display).toContain('DEFAULT_TEAM_LOGOS');
    // U46 — 세 보드 씬이 쓰는 모노그램도 같은 예열 목록에 들어간다
    expect(display).toContain('for (const src of [...DEFAULT_TEAM_LOGOS, EVENT_MARK_SRC]) {');
    expect(display).toContain('warm.src = src;');
  });

  it('JS가 붙이는 team-badge 클래스에 대응 CSS 규칙이 있다', () => {
    const css = read('./styles/display.css');
    expect(css).toContain('.team-badge {');
    // 아바타(부모)와 대결 아이콘(자기 자신) 두 경로 모두 링을 hairline으로 낮춘다
    expect(css).toContain('.luxe-avatar:has(.team-badge)');
    expect(css).toContain('.sb__avatar:has(.team-badge)');
    expect(css).toContain('.vs-teams__logo.team-badge');
  });
});
