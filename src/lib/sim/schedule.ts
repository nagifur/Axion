export type SchedulePeriod = 'work' | 'lunch' | 'break' | 'free';

export interface ScheduleBlock {
  /** Local 24-hour time, HH:MM. End is exclusive; blocks can cross midnight. */
  start: string;
  end: string;
  period: SchedulePeriod;
}

// First matching block wins, so breaks override the working day.
export const DEFAULT_SCHEDULE: readonly ScheduleBlock[] = [
  { start: '10:00', end: '10:15', period: 'break' },
  { start: '12:00', end: '13:00', period: 'lunch' },
  { start: '15:00', end: '15:15', period: 'break' },
  { start: '08:00', end: '17:00', period: 'work' },
];

const DAY_WATCH: readonly ScheduleBlock[] = [{ start: '06:00', end: '18:00', period: 'work' }];
const NIGHT_WATCH: readonly ScheduleBlock[] = [{ start: '18:00', end: '06:00', period: 'work' }];

export function securitySchedule(date: Date): readonly ScheduleBlock[] {
  return scheduleAt(DAY_WATCH, date) === 'work' ? DAY_WATCH : NIGHT_WATCH;
}

/** Keys are personnel filename slugs. An override replaces the shared schedule. */
export const SCHEDULE_OVERRIDES: Record<string, readonly ScheduleBlock[]> = {};

function minuteOfDay(time: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid schedule time "${time}": expected HH:MM between 00:00 and 23:59.`);
  }
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

export function scheduleAt(schedule: readonly ScheduleBlock[], date: Date): SchedulePeriod {
  if (!Number.isFinite(date.getTime())) throw new Error('Cannot resolve a schedule for an invalid date.');
  const minute = date.getHours() * 60 + date.getMinutes();
  const blocks = schedule.map((block) => {
    const start = minuteOfDay(block.start);
    const end = minuteOfDay(block.end);
    if (start === end) throw new Error(`Schedule block ${block.start}-${block.end} must have a nonzero duration.`);
    return { start, end, period: block.period };
  });
  return blocks.find(({ start, end }) =>
    start < end ? minute >= start && minute < end : minute >= start || minute < end)?.period ?? 'free';
}

export function scheduleFor(character: { id: string; schedule?: readonly ScheduleBlock[] }, date: Date): SchedulePeriod {
  if (character.schedule) return scheduleAt(character.schedule, date);
  const schedule = Object.hasOwn(SCHEDULE_OVERRIDES, character.id) ? SCHEDULE_OVERRIDES[character.id] : DEFAULT_SCHEDULE;
  return scheduleAt(schedule, date);
}
