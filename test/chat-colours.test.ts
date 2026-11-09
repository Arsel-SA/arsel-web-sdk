import { describe, expect, it } from 'vitest';
import { inkOf, textOn } from '../src/chat-colours';

describe('textOn', () => {
  it('keeps white on a colour dark enough for it', () => {
    expect(textOn('#2563EB')).toBe('#ffffff');
    expect(textOn('#0F766E')).toBe('#ffffff');
  });

  it('turns to near-black on a light colour, where white would not read', () => {
    expect(textOn('#84CC16')).toBe('#0f172a');
    expect(textOn('#FACC15')).toBe('#0f172a');
  });

  it('falls back to white for something that is not a colour', () => {
    expect(textOn('lime')).toBe('#ffffff');
  });
});

describe('inkOf', () => {
  it('leaves a colour that reads on white as it is', () => {
    expect(inkOf('#2563EB')).toBe('#2563EB');
  });

  it('darkens a light colour until it reads on white', () => {
    expect(inkOf('#84CC16')).toBe('#4f7a0d');
    expect(inkOf('#FFFFFF')).toBe('#737373');
  });

  it('leaves something that is not a colour alone', () => {
    expect(inkOf('lime')).toBe('lime');
  });
});
