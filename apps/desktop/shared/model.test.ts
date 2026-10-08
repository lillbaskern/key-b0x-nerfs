import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MELEE_CONFIG,
  DEFAULT_BINDINGS,
  cloneMeleeConfig,
  findDuplicateBindings,
  formatKeyLabel,
  layoutKeyLabel
} from './model';

describe('model helpers', () => {
  it('formats key labels for common bindings', () => {
    expect(formatKeyLabel('BracketRight')).toBe(']');
    expect(formatKeyLabel('Digit3')).toBe('3');
    expect(formatKeyLabel('KeyV')).toBe('V');
    expect(formatKeyLabel('ArrowUp')).toBe('Up');
  });

  it('falls back to US labels when no layout map is available', () => {
    expect(layoutKeyLabel('Semicolon')).toBe(';');
    expect(layoutKeyLabel('Slash')).toBe('/');
    expect(layoutKeyLabel('IntlBackslash')).toBe('\\');
  });

  it('labels keys with the active keyboard layout', () => {
    // German QWERTZ: ß sits where US has -, < where US has the ISO key,
    // and modifier keys produce no character at all.
    const german = new Map([
      ['Minus', 'ß'],
      ['Slash', '-'],
      ['KeyQ', 'q'],
      ['IntlBackslash', '<'],
      ['ShiftLeft', '']
    ]);

    expect(layoutKeyLabel('Minus', german)).toBe('ß');
    expect(layoutKeyLabel('Slash', german)).toBe('-');
    expect(layoutKeyLabel('KeyQ', german)).toBe('Q');
    expect(layoutKeyLabel('IntlBackslash', german)).toBe('<');
    // Empty values (keys without a character) and unknown codes fall back.
    expect(layoutKeyLabel('ShiftLeft', german)).toBe('Left Shift');
    expect(layoutKeyLabel('ArrowUp', german)).toBe('Up');

    // Accented letters uppercase like the US labels (Å), unlike ß which
    // expands to SS when uppercased and therefore keeps its keycap form.
    const swedish = new Map([
      ['BracketRight', 'å'],
      ['Semicolon', 'ö'],
      ['Quote', 'ä'],
      ['Minus', '+']
    ]);

    expect(layoutKeyLabel('BracketRight', swedish)).toBe('Å');
    expect(layoutKeyLabel('Semicolon', swedish)).toBe('Ö');
    expect(layoutKeyLabel('Quote', swedish)).toBe('Ä');
    expect(layoutKeyLabel('Minus', swedish)).toBe('+');
  });

  it('uses the US label when the layout matches', () => {
    const us = new Map([
      ['Semicolon', ';'],
      ['Slash', '/'],
      ['KeyV', 'v']
    ]);

    expect(layoutKeyLabel('Semicolon', us)).toBe(';');
    expect(layoutKeyLabel('Slash', us)).toBe('/');
    expect(layoutKeyLabel('KeyV', us)).toBe('V');
  });

  it('finds duplicate bindings', () => {
    const duplicates = findDuplicateBindings({
      ...DEFAULT_BINDINGS,
      a: 'KeyM',
      b: 'KeyM'
    });

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toEqual({
      key: 'KeyM',
      bindings: ['a', 'b']
    });
  });

  it('clones melee configs without sharing nested objects', () => {
    const copy = cloneMeleeConfig({
      ...DEFAULT_MELEE_CONFIG,
      airdodge: {
        kind: 'custom_mod_x_diagonal',
        x: 0.625,
        y: 0.75
      },
      nerfs: {
        enabled: true,
        travel_time: true,
        fuzzing: false,
        coordinate_limits: true,
        timing_lockouts: false
      }
    });

    expect(copy).toEqual({
      socd: {
        main_x: 'neutral',
        main_y: 'neutral',
        c_x: 'neutral',
        c_y: 'neutral'
      },
      down_diagonal: 'auto_jab_cancel',
      horizontal_socd_override: 'max_jump_trajectory',
      airdodge: {
        kind: 'custom_mod_x_diagonal',
        x: 0.625,
        y: 0.75
      },
      nerfs: {
        enabled: true,
        travel_time: true,
        fuzzing: false,
        coordinate_limits: true,
        timing_lockouts: false
      }
    });
    expect(copy.socd).not.toBe(DEFAULT_MELEE_CONFIG.socd);
    expect(copy.nerfs).not.toBe(DEFAULT_MELEE_CONFIG.nerfs);
  });

  it('enables every rectangle nerf by default', () => {
    expect(DEFAULT_MELEE_CONFIG.nerfs).toEqual({
      enabled: true,
      travel_time: true,
      fuzzing: true,
      coordinate_limits: true,
      timing_lockouts: true
    });
  });

  it('defaults SOCD to neutral on every axis', () => {
    expect(DEFAULT_MELEE_CONFIG.socd).toEqual({
      main_x: 'neutral',
      main_y: 'neutral',
      c_x: 'neutral',
      c_y: 'neutral'
    });
  });
});
