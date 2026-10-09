/**
 * TTS 리모컨 (tts-remote)
 *
 * ST 내장 TTS 확장 위에 얹는 리모컨. 설정값을 직접 쓰지 않고, TTS 확장 탭의
 * 원래 컨트롤을 대신 조작한다(native click / val+trigger). 저장·검증·voicemap
 * 반영은 전부 ST TTS 쪽 핸들러가 그대로 한다.
 *
 * 원본 참조 (SillyTavern 1.19.0):
 *   public/scripts/extensions/tts/settings.html  - 체크박스 id, #playback_rate
 *   public/scripts/extensions/tts/index.js:430   - addAudioControl (#ttsExtensionMenuItem / #ttsExtensionNarrateAll)
 *   public/scripts/extensions/tts/index.js:400   - updateUiAudioPlayState (#tts_media_control 클래스)
 *   public/scripts/extensions/tts/index.js:1403  - VoiceMapEntry.addUI (#tts_voicemap_char_*_voice)
 *   public/scripts/templates/wandMenu.html:7     - #tts_wand_container
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const MODULE_NAME = 'tts_remote';
const LS_POS_CARD = 'tts_remote_pos_card';
const LS_POS_BAR = 'tts_remote_pos_bar';
const EDGE_MARGIN = 4;

const defaultSettings = {
    displayMode: 'wand', // 'wand' | 'always'
};

/** 원래 TTS 컨트롤 셀렉터. 전부 매번 재조회한다 (캐시 금지). */
const SRC = {
    settingsRoot: '#tts_settings',
    enabled: '#tts_enabled',
    provider: '#tts_provider',
    voicemapBlock: '#tts_voicemap_block',
    playbackRate: '#playback_rate',
    wandContainer: '#tts_wand_container',
    playItem: '#ttsExtensionMenuItem',
    playIcon: '#tts_media_control',
    narrateAll: '#ttsExtensionNarrateAll',
};

/** 읽기 옵션 알약 ↔ 원래 체크박스 매핑. */
const OPTION_SPECS = [
    { key: 'auto', label: '자동 낭독', selector: '#tts_auto_generation' },
    { key: 'quoted', label: '따옴표 대사만', selector: '#tts_narrate_quoted' },
    { key: 'user', label: '내 메시지도 읽기', selector: '#tts_narrate_user' },
    { key: 'asterisk', label: '*지문* 건너뛰기', selector: '#tts_narrate_dialogues' },
];

/** 런타임 상태 (표시 방식은 settings, 펼침 여부는 세션 한정). */
const ui = {
    cardOpen: false,
    selectedChar: null,
};

let refreshTimer = null;

//#region ───────────────── 순수 로직 (하네스 검증 대상) ─────────────────

/**
 * 뷰포트 안으로 좌표를 가둔다.
 * @param {{x:number,y:number}} pos
 * @param {{w:number,h:number}} size
 * @param {{w:number,h:number}} viewport
 * @param {number} margin
 * @returns {{x:number,y:number}}
 */
function clampPosition(pos, size, viewport, margin) {
    const m = typeof margin === 'number' ? margin : EDGE_MARGIN;
    const maxX = Math.max(m, viewport.w - size.w - m);
    const maxY = Math.max(m, viewport.h - size.h - m);
    const x = Math.min(Math.max(Number(pos.x) || 0, m), maxX);
    const y = Math.min(Math.max(Number(pos.y) || 0, m), maxY);
    return { x, y };
}

/**
 * 표시 방식 상태 전이.
 * @param {{mode:string, cardOpen:boolean}} state
 * @param {string} action - 'wandClick' | 'close' | 'barExpand' | 'togglePin'
 * @returns {{mode:string, cardOpen:boolean}}
 */
function nextDisplayState(state, action) {
    const mode = state.mode === 'always' ? 'always' : 'wand';
    const cardOpen = !!state.cardOpen;

    if (action === 'close') {
        return { mode, cardOpen: false };
    }
    if (action === 'togglePin') {
        return mode === 'wand'
            ? { mode: 'always', cardOpen: false }
            : { mode: 'wand', cardOpen: true };
    }
    if (action === 'barExpand') {
        return mode === 'always' ? { mode, cardOpen: true } : { mode, cardOpen };
    }
    if (action === 'wandClick') {
        return mode === 'always' ? { mode, cardOpen: !cardOpen } : { mode, cardOpen: true };
    }
    return { mode, cardOpen };
}

/**
 * 상태로부터 카드·바 표시 여부를 유도한다.
 * @param {{mode:string, cardOpen:boolean}} state
 * @returns {{card:boolean, bar:boolean}}
 */
function visibilityFor(state) {
    const mode = state.mode === 'always' ? 'always' : 'wand';
    const cardOpen = !!state.cardOpen;
    return { card: cardOpen, bar: mode === 'always' && !cardOpen };
}

/**
 * #tts_media_control 의 클래스 문자열에서 재생 상태를 읽는다.
 * (tts/index.js:406-410 - 재생/처리 중이면 fa-stop-circle)
 * @param {string} className
 * @returns {boolean} 재생(또는 처리) 중이면 true
 */
function isPlayingFromClass(className) {
    return typeof className === 'string' && className.indexOf('fa-stop-circle') !== -1;
}

//#endregion

//#region ───────────────── 설정 ─────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings);
    }
    const s = extension_settings[MODULE_NAME];
    if (s.displayMode !== 'wand' && s.displayMode !== 'always') {
        s.displayMode = defaultSettings.displayMode;
    }
    return s;
}

function setDisplayMode(mode) {
    getSettings().displayMode = mode;
    saveSettingsDebounced();
}

function loadPos(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
}

function savePos(key, pos) {
    try {
        localStorage.setItem(key, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
    } catch {
        /* 사생활 모드 등에서 localStorage가 막혀도 동작은 계속한다 */
    }
}

//#endregion

//#region ───────────────── 원래 컨트롤 대리 조작 ─────────────────

function isTtsExtensionLoaded() {
    return document.querySelector(SRC.settingsRoot) !== null;
}

function isTtsEnabled() {
    const el = document.querySelector(SRC.enabled);
    return !!(el && el.checked);
}

function currentProviderName() {
    const el = document.querySelector(SRC.provider);
    return el && el.value ? String(el.value) : '';
}

/**
 * 체크박스 대리 클릭. 원하는 상태와 다를 때만 native click 한다.
 * jQuery .trigger('click') 은 핸들러 실행 뒤 native click 을 한 번 더 태워
 * 체크 상태가 뒤집히는 버전이 있어 쓰지 않는다. native click 은 사용자의
 * 실제 클릭과 동일 경로라 ST 쪽 on('click') 핸들러가 새 상태를 그대로 읽는다.
 */
function setSourceCheckbox(selector, desired) {
    const el = document.querySelector(selector);
    if (!el) return false;
    if (el.checked !== !!desired) {
        el.click();
    }
    return true;
}

function readSourceCheckbox(selector) {
    const el = document.querySelector(selector);
    return el ? { present: true, checked: !!el.checked } : { present: false, checked: false };
}

/** voicemap DOM 에서 (이름, select id) 목록을 읽는다. id 계산을 재구현하지 않는다. */
function readVoiceEntries() {
    const out = [];
    $(SRC.voicemapBlock).find('.tts_voicemap_block_char').each(function () {
        const $block = $(this);
        const $name = $block.find('span[id^="tts_voicemap_char_"]').first();
        const $select = $block.find('select[id^="tts_voicemap_char_"]').first();
        if (!$name.length || !$select.length) return;
        const id = $select.attr('id');
        if (!id) return;
        out.push({ name: String($name.text()).trim(), selectId: id });
    });
    return out;
}

function playbackRateValue() {
    const el = document.querySelector(SRC.playbackRate);
    return el ? Number(el.value) : 1;
}

//#endregion

//#region ───────────────── DOM 생성 ─────────────────

function buildCard() {
    const pills = OPTION_SPECS
        .map(o => `<div class="ttsr-pill" data-ttsr-opt="${o.key}" role="button" tabindex="0"><span>${o.label}</span></div>`)
        .join('');

    const html = `
    <div id="ttsr_card" class="ttsr-card" style="display:none;">
        <div class="ttsr-head" id="ttsr_card_head">
            <span class="ttsr-title">TTS 리모컨</span>
            <label class="ttsr-switch ttsr-nodrag" title="TTS 켜기 / 끄기">
                <input type="checkbox" id="ttsr_enabled">
                <span class="ttsr-knob"></span>
            </label>
            <span class="ttsr-spacer"></span>
            <div id="ttsr_pin" class="ttsr-iconbtn" role="button" tabindex="0" title="표시 방식 전환">📌</div>
            <div id="ttsr_close" class="ttsr-iconbtn" role="button" tabindex="0" title="닫기">✕</div>
        </div>
        <div class="ttsr-body">
            <div id="ttsr_notice" class="ttsr-notice" style="display:none;">
                <div class="ttsr-notice-text">확장 탭에서 먼저 TTS를 연결해 주세요.</div>
                <div id="ttsr_open_settings" class="ttsr-btn" role="button" tabindex="0">확장 탭 열기</div>
            </div>
            <div id="ttsr_main" class="ttsr-main">
                <div class="ttsr-provider"><span class="ttsr-label">공급자</span><b id="ttsr_provider_name">—</b></div>
                <div class="ttsr-row">
                    <div id="ttsr_play" class="ttsr-btn ttsr-grow" role="button" tabindex="0">
                        <i id="ttsr_play_icon" class="fa-solid fa-circle-play"></i>
                        <span id="ttsr_play_label">마지막 메시지 읽기</span>
                    </div>
                    <div id="ttsr_narrate_all" class="ttsr-btn" role="button" tabindex="0" title="이 대화 전체 읽기">📻</div>
                </div>
                <div class="ttsr-row ttsr-voicerow">
                    <div class="ttsr-field">
                        <span class="ttsr-label">누구</span>
                        <select id="ttsr_char" class="ttsr-nodrag"></select>
                        <span id="ttsr_char_fixed" class="ttsr-fixed" style="display:none;"></span>
                    </div>
                    <div class="ttsr-field">
                        <span class="ttsr-label">어떤 목소리</span>
                        <select id="ttsr_voice" class="ttsr-nodrag"></select>
                    </div>
                </div>
                <div class="ttsr-row ttsr-pills">${pills}</div>
                <div class="ttsr-row ttsr-raterow" id="ttsr_rate_row">
                    <span class="ttsr-label">속도</span>
                    <input type="range" id="ttsr_rate" class="ttsr-nodrag" min="0" max="3" step="0.05">
                    <span id="ttsr_rate_val" class="ttsr-fixed">1.00</span>
                </div>
            </div>
        </div>
    </div>`;

    $(document.body).append(html);
}

function buildBar() {
    const html = `
    <div id="ttsr_bar" class="ttsr-bar" style="display:none;">
        <div id="ttsr_bar_power" class="ttsr-bar-btn" role="button" tabindex="0" title="TTS 켜기 / 끄기">🔊</div>
        <div id="ttsr_bar_play" class="ttsr-bar-btn" role="button" tabindex="0" title="정지 / 재생"><i id="ttsr_bar_play_icon" class="fa-solid fa-circle-play"></i></div>
        <div id="ttsr_bar_expand" class="ttsr-bar-btn" role="button" tabindex="0" title="리모컨 펼치기">▾</div>
    </div>`;
    $(document.body).append(html);
}

/**
 * 요술봉 메뉴 항목. 전용 컨테이너를 만들어 TTS 두 칸 바로 아래에 끼운다.
 * 붙인 뒤 전역 $('#id') 로 다시 집지 않고 이 핸들을 계속 쓴다.
 */
let $wandItem = null;

function buildWandItem() {
    const $container = $('<div id="tts_remote_wand_container" class="extension_container"></div>');
    const $ttsContainer = $(SRC.wandContainer);
    if ($ttsContainer.length) {
        $ttsContainer.after($container);
    } else {
        $('#extensionsMenu').append($container);
    }

    $wandItem = $(`
        <div id="ttsRemoteMenuItem" class="list-group-item flex-container flexGap5" title="TTS 리모컨">
            <div class="extensionsMenuExtensionButton fa-solid fa-sliders"></div>
            <span>TTS 리모컨</span>
        </div>`);
    $wandItem.on('click', onWandItemClick);
    $container.append($wandItem);
}

//#endregion

//#region ───────────────── 동작 ─────────────────

function applyDisplayState() {
    const state = { mode: getSettings().displayMode, cardOpen: ui.cardOpen };
    const vis = visibilityFor(state);

    $('#ttsr_card').toggle(vis.card);
    $('#ttsr_bar').toggle(vis.bar);

    if (vis.card) {
        placeElement('#ttsr_card', LS_POS_CARD);
    }
    if (vis.bar) {
        placeElement('#ttsr_bar', LS_POS_BAR);
    }
    if (vis.card || vis.bar) {
        refreshNow();
    }
}

function transition(action) {
    const before = { mode: getSettings().displayMode, cardOpen: ui.cardOpen };
    const after = nextDisplayState(before, action);
    if (after.mode !== before.mode) {
        setDisplayMode(after.mode);
    }
    ui.cardOpen = after.cardOpen;
    applyDisplayState();
}

function onWandItemClick() {
    transition('wandClick');
}

/** 기본 위치 = 입력창(#send_form) 위 왼쪽. 요술봉 근처이고 오른쪽 버튼들을 피한다. */
function defaultPosition(w, h) {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const form = document.getElementById('send_form');
    if (form) {
        const r = form.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
            return clampPosition({ x: r.left + 8, y: r.top - h - 8 }, { w, h }, viewport, EDGE_MARGIN);
        }
    }
    return clampPosition({ x: 16, y: viewport.h - h - 90 }, { w, h }, viewport, EDGE_MARGIN);
}

function placeElement(selector, lsKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = { w: rect.width || el.offsetWidth || 240, h: rect.height || el.offsetHeight || 60 };
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const saved = loadPos(lsKey);
    const pos = saved
        ? clampPosition(saved, size, viewport, EDGE_MARGIN)
        : defaultPosition(size.w, size.h);
    el.style.left = `${Math.round(pos.x)}px`;
    el.style.top = `${Math.round(pos.y)}px`;
}

function reclampAll() {
    if ($('#ttsr_card').is(':visible')) placeElement('#ttsr_card', LS_POS_CARD);
    if ($('#ttsr_bar').is(':visible')) placeElement('#ttsr_bar', LS_POS_BAR);
}

const DRAG_THRESHOLD = 4;

/**
 * 포인터 이벤트 드래그.
 * 버튼 위에서 집어도 끌 수 있게 임계값(4px) 방식을 쓴다. 문턱 전에는 그냥
 * 클릭으로 끝나고, 넘어서면 그 번 클릭을 캡처 단계에서 한 번 삼킨다.
 * 값을 드래그해야 하는 폼 컨트롤과 .ttsr-nodrag 은 제외한다.
 */
function makeDraggable(selector, handleSelector, lsKey) {
    const root = document.querySelector(selector);
    const handle = document.querySelector(handleSelector);
    if (!root || !handle) return;

    let pending = false;
    let dragging = false;
    let startX = 0, startY = 0, baseX = 0, baseY = 0, pid = null;

    handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target instanceof Element && e.target.closest('input, select, textarea, .ttsr-nodrag')) return;
        const rect = root.getBoundingClientRect();
        pending = true;
        dragging = false;
        pid = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        baseX = rect.left;
        baseY = rect.top;
    });

    handle.addEventListener('pointermove', (e) => {
        if (!pending || e.pointerId !== pid) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging) {
            if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            dragging = true;
            root.classList.add('ttsr-dragging');
            // capture only after the drag threshold: capturing on pointerdown retargets the click to the handle, so child buttons (close/pin/bar) never get it
            try { handle.setPointerCapture(pid); } catch { /* ignore */ }
        }
        e.preventDefault();
        const rect = root.getBoundingClientRect();
        const pos = clampPosition(
            { x: baseX + dx, y: baseY + dy },
            { w: rect.width, h: rect.height },
            { w: window.innerWidth, h: window.innerHeight },
            EDGE_MARGIN,
        );
        root.style.left = `${Math.round(pos.x)}px`;
        root.style.top = `${Math.round(pos.y)}px`;
    });

    const end = (e) => {
        if (!pending || (pid !== null && e.pointerId !== pid)) return;
        try { handle.releasePointerCapture(pid); } catch { /* 이미 해제됨 */ }
        pending = false;
        pid = null;
        if (!dragging) return;
        dragging = false;
        root.classList.remove('ttsr-dragging');
        root.addEventListener('click', swallowClick, { capture: true, once: true });
        const rect = root.getBoundingClientRect();
        savePos(lsKey, { x: rect.left, y: rect.top });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

function swallowClick(e) {
    e.stopPropagation();
    e.preventDefault();
}

//#endregion

//#region ───────────────── 동기화(읽기) ─────────────────

function scheduleRefresh(delayMs) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshNow, typeof delayMs === 'number' ? delayMs : 60);
}

function refreshPlayState() {
    const icon = document.querySelector(SRC.playIcon);
    const playing = icon ? isPlayingFromClass(icon.getAttribute('class') || '') : false;
    const cls = playing ? 'fa-solid fa-stop-circle' : 'fa-solid fa-circle-play';
    $('#ttsr_play_icon').attr('class', cls);
    $('#ttsr_bar_play_icon').attr('class', cls);
    $('#ttsr_play_label').text(playing ? '정지' : '마지막 메시지 읽기');
}

function refreshWandItemVisibility() {
    const show = isTtsExtensionLoaded();
    $('#tts_remote_wand_container').toggle(show);
}

function refreshNow() {
    refreshWandItemVisibility();

    const loaded = isTtsExtensionLoaded();
    const enabled = loaded && isTtsEnabled();
    const entries = readVoiceEntries();
    const provider = currentProviderName();

    $('#ttsr_enabled').prop('checked', enabled).prop('disabled', !loaded);
    $('#ttsr_bar_power').toggleClass('ttsr-on', enabled);

    // 공급자 미설정 / 목소리 목록이 비었을 때
    const needsSetup = loaded && enabled && entries.length === 0;
    $('#ttsr_notice').toggle(!loaded || needsSetup);
    $('#ttsr_main').toggleClass('ttsr-locked', !enabled);
    $('#ttsr_main').toggle(loaded);

    $('#ttsr_provider_name').text(provider || '—');
    refreshPlayState();

    // 읽기 옵션
    for (const opt of OPTION_SPECS) {
        const state = readSourceCheckbox(opt.selector);
        const $pill = $(`.ttsr-pill[data-ttsr-opt="${opt.key}"]`);
        $pill.toggleClass('ttsr-on', state.checked);
        $pill.toggleClass('ttsr-missing', !state.present);
    }

    // 속도 (공급자 System 이면 숨김 - tts/index.js:898 과 동일 조건)
    const rate = playbackRateValue();
    $('#ttsr_rate').val(String(rate));
    $('#ttsr_rate_val').text(Number(rate).toFixed(2));
    $('#ttsr_rate_row').toggle(provider !== 'System');

    refreshVoiceControls(entries);
}

function refreshVoiceControls(entries) {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const isGroup = !!(ctx && ctx.groupId !== null && ctx.groupId !== undefined);
    const charName = ctx ? ctx.name2 : null;

    const $char = $('#ttsr_char');
    const $fixed = $('#ttsr_char_fixed');
    const $voice = $('#ttsr_voice');

    if (!entries.length) {
        $char.empty().hide();
        $fixed.hide();
        $voice.empty().prop('disabled', true);
        return;
    }

    const names = entries.map(e => e.name);
    // 1:1 대화면 캐릭터 이름을 고정 표시한다. 그 캐릭터가 voicemap 에 없으면
    // 선택지를 잃지 않도록 드롭다운으로 되돌린다.
    const fixedTarget = (!isGroup && charName && names.includes(charName)) ? charName : null;

    if (fixedTarget) {
        ui.selectedChar = fixedTarget;
        $fixed.text(fixedTarget).show();
        $char.hide();
    } else {
        if (!ui.selectedChar || !names.includes(ui.selectedChar)) {
            ui.selectedChar = (charName && names.includes(charName)) ? charName : names[0];
        }
        $fixed.hide();
        $char.show();
        $char.empty();
        for (const name of names) {
            $char.append($('<option></option>').val(name).text(name));
        }
        $char.val(ui.selectedChar);
    }

    const entry = entries.find(e => e.name === ui.selectedChar) || entries[0];
    const $srcSelect = $(`#${window.CSS && CSS.escape ? CSS.escape(entry.selectId) : entry.selectId}`);
    $voice.empty();
    if (!$srcSelect.length) {
        $voice.prop('disabled', true);
        return;
    }
    $srcSelect.find('option').each(function () {
        const text = $(this).text();
        const value = $(this).attr('value');
        const $opt = $('<option></option>').text(text);
        $opt.attr('value', value === undefined ? text : value);
        $voice.append($opt);
    });
    $voice.prop('disabled', false);
    $voice.val($srcSelect.val());
}

//#endregion

//#region ───────────────── 이벤트 배선 ─────────────────

function bindRemoteHandlers() {
    // 머리줄
    $('#ttsr_enabled').on('change', function () {
        setSourceCheckbox(SRC.enabled, $(this).is(':checked'));
        scheduleRefresh(150);
    });
    $('#ttsr_pin').on('click', () => transition('togglePin'));
    $('#ttsr_close').on('click', () => transition('close'));

    // 재생 줄
    $('#ttsr_play').on('click', () => {
        $(SRC.playItem).trigger('click');
        scheduleRefresh(50);
    });
    $('#ttsr_narrate_all').on('click', () => {
        $(SRC.narrateAll).trigger('click');
        scheduleRefresh(50);
    });

    // 목소리
    $('#ttsr_char').on('change', function () {
        ui.selectedChar = String($(this).val());
        refreshVoiceControls(readVoiceEntries());
    });
    $('#ttsr_voice').on('change', function () {
        const entries = readVoiceEntries();
        const entry = entries.find(e => e.name === ui.selectedChar);
        if (!entry) return;
        const $srcSelect = $(`#${window.CSS && CSS.escape ? CSS.escape(entry.selectId) : entry.selectId}`);
        if (!$srcSelect.length) return;
        $srcSelect.val(String($(this).val())).trigger('change');
    });

    // 읽기 옵션
    $(document).on('click', '#ttsr_card .ttsr-pill', function () {
        const key = $(this).attr('data-ttsr-opt');
        const spec = OPTION_SPECS.find(o => o.key === key);
        if (!spec) return;
        const state = readSourceCheckbox(spec.selector);
        if (!state.present) {
            toastr.info('이 옵션은 지금 TTS 확장에 없어요.');
            return;
        }
        setSourceCheckbox(spec.selector, !state.checked);
        scheduleRefresh(80);
    });

    // 속도
    $('#ttsr_rate').on('input', function () {
        const value = $(this).val();
        $('#ttsr_rate_val').text(Number(value).toFixed(2));
        $(SRC.playbackRate).val(value).trigger('input');
    });

    // 안내 → 확장 탭 열기
    $('#ttsr_open_settings').on('click', openTtsSettingsPanel);

    // 접힌 바
    $('#ttsr_bar_power').on('click', () => {
        setSourceCheckbox(SRC.enabled, !isTtsEnabled());
        scheduleRefresh(150);
    });
    $('#ttsr_bar_play').on('click', () => {
        $(SRC.playItem).trigger('click');
        scheduleRefresh(50);
    });
    $('#ttsr_bar_expand').on('click', () => transition('barExpand'));
}

/** 확장 서랍을 열고 TTS 서랍까지 펼친다. display 를 직접 건드리지 않는다. */
function openTtsSettingsPanel() {
    const block = document.getElementById('rm_extensions_block');
    if (block && !block.classList.contains('openDrawer')) {
        // 핸들러는 부모 .drawer-toggle 에 걸려 있다 (script.js:12150)
        $('#extensions-settings-button .drawer-toggle').trigger('click');
    }
    setTimeout(() => {
        const $root = $(SRC.settingsRoot);
        if (!$root.length) return;
        const $content = $root.find('.inline-drawer-content').first();
        if ($content.length && !$content.is(':visible')) {
            $root.find('.inline-drawer-toggle').first().trigger('click');
        }
        $root[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 350);
}

/** 원래 탭에서 바뀐 값도 리모컨에 반영한다. (위임 바인딩 - 재생성돼도 살아남는다) */
function bindSourceMirrors() {
    const sources = [
        SRC.enabled,
        SRC.provider,
        SRC.playbackRate,
        ...OPTION_SPECS.map(o => o.selector),
    ].join(', ');
    $(document).on('click change input', sources, () => scheduleRefresh(120));
    $(document).on('change', '#tts_voicemap_block select', () => scheduleRefresh(120));
}

function observePlayState() {
    const target = document.querySelector(SRC.wandContainer);
    if (!target) return false;
    const observer = new MutationObserver(() => refreshPlayState());
    observer.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    return true;
}

function observeVoiceMap() {
    const target = document.querySelector(SRC.voicemapBlock);
    if (!target) return false;
    const observer = new MutationObserver(() => scheduleRefresh(120));
    observer.observe(target, { childList: true });
    return true;
}

//#endregion

//#region ───────────────── 초기화 ─────────────────

/** TTS 확장과 요술봉 템플릿은 우리보다 늦게 붙을 수 있다. 붙을 때까지 재시도한다. */
function waitAndAttach() {
    let tries = 0;
    let gotPlay = false;
    let gotVoiceMap = false;
    const timer = setInterval(() => {
        tries++;
        if (!gotPlay) gotPlay = observePlayState();
        if (!gotVoiceMap) gotVoiceMap = observeVoiceMap();
        refreshWandItemVisibility();
        if ((gotPlay && gotVoiceMap) || tries >= 40) {
            clearInterval(timer);
            refreshNow();
        }
    }, 500);
}

jQuery(async () => {
    getSettings();

    buildCard();
    buildBar();
    buildWandItem();

    bindRemoteHandlers();
    bindSourceMirrors();

    makeDraggable('#ttsr_card', '#ttsr_card_head', LS_POS_CARD);
    makeDraggable('#ttsr_bar', '#ttsr_bar', LS_POS_BAR);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        // voicemap 은 onChatChanged 안에서 initVoiceMap 으로 다시 그려진다
        // (tts/index.js:1093-1098). 재생성 뒤를 노려 두 번 읽는다.
        scheduleRefresh(400);
        setTimeout(refreshNow, 1500);
    });
    eventSource.on(event_types.GROUP_UPDATED, () => scheduleRefresh(400));
    eventSource.on(event_types.APP_READY, () => scheduleRefresh(300));

    window.addEventListener('resize', reclampAll);

    applyDisplayState();
    waitAndAttach();

    console.log('[tts-remote] 리모컨 준비됨. 표시 방식:', getSettings().displayMode);
});

//#endregion
