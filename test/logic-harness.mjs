/**
 * 순수 로직 하네스.
 * index.js 를 복붙하지 않고 소스에서 함수 선언을 프로그램으로 잘라내 new Function 에
 * 넣고 돌린다. DOM·jQuery·ST import 없이 clampPosition / nextDisplayState /
 * visibilityFor / isPlayingFromClass 네 개만 검증한다.
 *
 * 실행: node test/logic-harness.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'index.js'), 'utf-8');

/** 최상위 `function NAME(` 선언을 중괄호 균형으로 잘라낸다. */
function cutFunction(src, name) {
    const start = src.indexOf(`\nfunction ${name}(`);
    if (start === -1) throw new Error(`함수를 못 찾음: ${name}`);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start + 1, j + 1);
        }
    }
    throw new Error(`중괄호 불균형: ${name}`);
}

const NAMES = ['clampPosition', 'nextDisplayState', 'visibilityFor', 'isPlayingFromClass'];
const body = NAMES.map(n => cutFunction(source, n)).join('\n\n');
// EDGE_MARGIN 은 모듈 상수라 스텁으로 주입한다 (index.js 의 값과 동일해야 한다).
const EDGE_MARGIN_IN_SOURCE = Number(/const EDGE_MARGIN = (\d+);/.exec(source)[1]);
const factory = new Function('EDGE_MARGIN', `${body}\nreturn { ${NAMES.join(', ')} };`);
const L = factory(EDGE_MARGIN_IN_SOURCE);

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.error(`FAIL ${label}\n  기대 ${e}\n  실제 ${a}`); }
}

// ── clampPosition ────────────────────────────────────────────────
const VP = { w: 1200, h: 800 };
const SZ = { w: 300, h: 200 };
check('clamp: 안쪽 좌표 그대로', L.clampPosition({ x: 100, y: 100 }, SZ, VP, 4), { x: 100, y: 100 });
check('clamp: 왼쪽 밖', L.clampPosition({ x: -50, y: 100 }, SZ, VP, 4), { x: 4, y: 100 });
check('clamp: 위쪽 밖', L.clampPosition({ x: 100, y: -999 }, SZ, VP, 4), { x: 100, y: 4 });
check('clamp: 오른쪽 밖', L.clampPosition({ x: 5000, y: 100 }, SZ, VP, 4), { x: 896, y: 100 });
check('clamp: 아래쪽 밖', L.clampPosition({ x: 100, y: 5000 }, SZ, VP, 4), { x: 100, y: 596 });
check('clamp: 우하단 모서리 정확히', L.clampPosition({ x: 896, y: 596 }, SZ, VP, 4), { x: 896, y: 596 });
check('clamp: 카드가 뷰포트보다 큼(세로)', L.clampPosition({ x: 10, y: 10 }, { w: 300, h: 2000 }, VP, 4), { x: 10, y: 4 });
check('clamp: 카드가 뷰포트보다 큼(가로)', L.clampPosition({ x: 10, y: 10 }, { w: 5000, h: 100 }, VP, 4), { x: 4, y: 10 });
check('clamp: margin 0', L.clampPosition({ x: -5, y: -5 }, SZ, VP, 0), { x: 0, y: 0 });
check('clamp: x가 NaN이면 0 취급', L.clampPosition({ x: NaN, y: 100 }, SZ, VP, 4), { x: 4, y: 100 });
check('clamp: margin 생략 시 기본값 사용', L.clampPosition({ x: -50, y: -50 }, SZ, VP), { x: EDGE_MARGIN_IN_SOURCE, y: EDGE_MARGIN_IN_SOURCE });
check('clamp: 모바일 세로 뷰포트', L.clampPosition({ x: 500, y: 900 }, { w: 390, h: 300 }, { w: 390, h: 844 }, 4), { x: 4, y: 540 });

// ── nextDisplayState ─────────────────────────────────────────────
const W_CLOSED = { mode: 'wand', cardOpen: false };
const W_OPEN = { mode: 'wand', cardOpen: true };
const A_BAR = { mode: 'always', cardOpen: false };
const A_OPEN = { mode: 'always', cardOpen: true };

check('wand+닫힘 + 요술봉클릭 = 카드 열림', L.nextDisplayState(W_CLOSED, 'wandClick'), W_OPEN);
check('wand+열림 + 요술봉클릭 = 그대로 열림', L.nextDisplayState(W_OPEN, 'wandClick'), W_OPEN);
check('wand+열림 + X = 닫힘', L.nextDisplayState(W_OPEN, 'close'), W_CLOSED);
check('wand + 핀 = 항상띄우기(바)', L.nextDisplayState(W_OPEN, 'togglePin'), A_BAR);
check('wand + 바펼침 = 변화없음', L.nextDisplayState(W_CLOSED, 'barExpand'), W_CLOSED);
check('always+바 + 요술봉클릭 = 펼침', L.nextDisplayState(A_BAR, 'wandClick'), A_OPEN);
check('always+열림 + 요술봉클릭 = 접힘', L.nextDisplayState(A_OPEN, 'wandClick'), A_BAR);
check('always+바 + 바펼침 = 펼침', L.nextDisplayState(A_BAR, 'barExpand'), A_OPEN);
check('always+열림 + X = 바로 복귀', L.nextDisplayState(A_OPEN, 'close'), A_BAR);
check('always + 핀 = 요술봉모드 + 카드 유지', L.nextDisplayState(A_OPEN, 'togglePin'), W_OPEN);
check('알 수 없는 액션은 무변화', L.nextDisplayState(A_OPEN, 'nope'), A_OPEN);
check('망가진 mode 는 wand 로 정규화', L.nextDisplayState({ mode: 'zzz', cardOpen: true }, 'close'), W_CLOSED);
check('핀 왕복(wand->always->wand)', L.nextDisplayState(L.nextDisplayState(W_OPEN, 'togglePin'), 'togglePin'), W_OPEN);

// ── visibilityFor ────────────────────────────────────────────────
check('vis: wand+닫힘 = 아무것도 안 보임', L.visibilityFor(W_CLOSED), { card: false, bar: false });
check('vis: wand+열림 = 카드만', L.visibilityFor(W_OPEN), { card: true, bar: false });
check('vis: always+접힘 = 바만', L.visibilityFor(A_BAR), { card: false, bar: true });
check('vis: always+펼침 = 카드만(바는 숨김)', L.visibilityFor(A_OPEN), { card: true, bar: false });
// 카드와 바가 동시에 뜨는 조합은 없어야 한다
for (const s of [W_CLOSED, W_OPEN, A_BAR, A_OPEN]) {
    const v = L.visibilityFor(s);
    check(`vis: 동시 표시 없음 (${s.mode}/${s.cardOpen})`, v.card && v.bar, false);
}

// ── isPlayingFromClass ───────────────────────────────────────────
check('재생중: stop 아이콘', L.isPlayingFromClass('fa-solid fa-stop-circle extensionsMenuExtensionButton'), true);
check('대기중: play 아이콘', L.isPlayingFromClass('fa-solid fa-circle-play extensionsMenuExtensionButton'), false);
check('초기값(TTS가 클래스 쓰기 전)', L.isPlayingFromClass('extensionsMenuExtensionButton '), false);
check('빈 문자열', L.isPlayingFromClass(''), false);
check('null', L.isPlayingFromClass(null), false);
check('undefined', L.isPlayingFromClass(undefined), false);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
