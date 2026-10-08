use std::time::{Duration, Instant};

use crate::config::NerfConfig;
use crate::coords::GAMECUBE_STICK_RADIUS;

pub(crate) const STICK_UNIT: f64 = 1.0 / GAMECUBE_STICK_RADIUS;
pub(crate) const DEADZONE: f64 = 23.0 / GAMECUBE_STICK_RADIUS;
pub(crate) const BANNED_NEAR_DEADZONE: f64 = 24.0 / GAMECUBE_STICK_RADIUS;
pub(crate) const SMASH_THRESHOLD: f64 = 0.7;
pub(crate) const DASH_THRESHOLD: f64 = 0.8;
pub(crate) const CROUCH_THRESHOLD: f64 = 0.6625;
pub(crate) const TILT_SIDE_B: f64 = 0.35;
pub(crate) const FTILT: f64 = 0.5;
pub(crate) const MIN_FREE_ANGLE_DEG: f64 = 20.0;
pub(crate) const MIN_SHIELD_ANGLE_DEG: f64 = 27.0;
pub(crate) const DIAGONAL_MIN_DEG: f64 = 41.5;
pub(crate) const DIAGONAL_MAX_DEG: f64 = 48.5;
pub(crate) const FAST_TRAVEL: Duration = Duration::from_millis(6);
pub(crate) const SLOW_TRAVEL: Duration = Duration::from_millis(12);

const SDI_LOCK: Duration = Duration::from_micros(91_667);
const CROUCH_UTILT_LOCK: Duration = Duration::from_millis(50);
const PIVOT_TILT_LOCK: Duration = Duration::from_micros(133_333);
const DIAGONAL_DASH_PIVOT_LOCK: Duration = Duration::from_micros(83_333);
const DTILT_BUFFER: Duration = Duration::from_micros(66_667);

#[derive(Clone, Debug)]
pub(crate) struct NerfRuntime {
    output: (f64, f64),
    travel: Travel,
    fuzzed_target: (f64, f64),
    last_user_target: Option<(f64, f64)>,
    rng: Lcg,
    lockouts: MotionLockouts,
    sdi: SdiLockout,
}

impl Default for NerfRuntime {
    fn default() -> Self {
        Self {
            output: (0.0, 0.0),
            travel: Travel::settled((0.0, 0.0)),
            fuzzed_target: (0.0, 0.0),
            last_user_target: None,
            rng: Lcg::from_entropy(),
            lockouts: MotionLockouts::default(),
            sdi: SdiLockout::default(),
        }
    }
}

impl NerfRuntime {
    pub(crate) fn output(&self) -> (f64, f64) {
        self.output
    }

    pub(crate) fn is_traveling(&self) -> bool {
        !self.travel.is_settled()
    }

    pub(crate) fn apply(
        &mut self,
        now: Instant,
        logical: (f64, f64),
        context: NerfContext,
        settings: NerfSettings,
        user_input_changed: bool,
    ) {
        let traveling = self.is_traveling();
        let (mut target, mut instant) = if settings.coordinate_limits {
            legalize_target(logical, context.shield, traveling)
        } else {
            (logical, false)
        };

        if settings.timing_lockouts {
            self.lockouts.observe(now, target, context);
            if let Some(forced) = self.lockouts.force_target(now, target) {
                target = forced;
                instant = true;
            }
        }

        if user_input_changed
            && self
                .last_user_target
                .map(|previous| !same_coord(previous, target))
                != Some(false)
        {
            self.fuzzed_target = if settings.fuzzing {
                fuzz_target(target, &mut self.rng)
            } else {
                target
            };
            self.last_user_target = Some(target);
        }

        let mut desired = self.fuzzed_target;

        // Reverse neutral-B lockout: pressing B inside the neutral-B region
        // outside the x-deadzone forces the tilt side-B zone, so a reverse
        // neutral-B requires flicking the stick, releasing it, then pressing B.
        // Applied after fuzzing so fuzz can never land back in neutral-B.
        if settings.coordinate_limits
            && context.b
            && in_deadzone(desired.1)
            && desired.0.abs() > DEADZONE
            && desired.0.abs() < TILT_SIDE_B
        {
            desired = (TILT_SIDE_B * desired.0.signum(), 0.0);
            instant = true;
        }

        if settings.timing_lockouts
            && let Some(held) = self.sdi.filter(now, desired)
        {
            desired = held;
            instant = true;
        }

        if instant || !settings.travel_time {
            self.travel = Travel::settled(desired);
            self.output = desired;
            return;
        }

        self.travel.set_target(self.output, desired, now);
        self.output = self.travel.sample(now);
    }

    pub(crate) fn tick(&mut self, now: Instant) {
        self.output = self.travel.sample(now);
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct NerfContext {
    pub shield: bool,
    pub b: bool,
    pub raw_horizontal: i8,
}

/// Per-family nerf switches resolved from [`NerfConfig`] for a single apply.
#[derive(Clone, Copy, Debug)]
pub(crate) struct NerfSettings {
    pub travel_time: bool,
    pub fuzzing: bool,
    pub coordinate_limits: bool,
    pub timing_lockouts: bool,
}

impl From<&NerfConfig> for NerfSettings {
    fn from(config: &NerfConfig) -> Self {
        Self {
            travel_time: config.travel_time,
            fuzzing: config.fuzzing,
            coordinate_limits: config.coordinate_limits,
            timing_lockouts: config.timing_lockouts,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Travel {
    start: (f64, f64),
    end: (f64, f64),
    started_at: Instant,
    duration: Duration,
    settled: bool,
}

impl Travel {
    fn settled(point: (f64, f64)) -> Self {
        Self {
            start: point,
            end: point,
            started_at: Instant::now(),
            duration: Duration::ZERO,
            settled: true,
        }
    }

    fn is_settled(&self) -> bool {
        self.settled
    }

    fn set_target(&mut self, current: (f64, f64), target: (f64, f64), now: Instant) {
        if same_coord(self.end, target) && !self.settled {
            return;
        }
        if same_coord(current, target) {
            *self = Self {
                start: target,
                end: target,
                started_at: now,
                duration: Duration::ZERO,
                settled: true,
            };
            return;
        }

        *self = Self {
            start: current,
            end: target,
            started_at: now,
            duration: travel_duration(current, target),
            settled: false,
        };
    }

    fn sample(&mut self, now: Instant) -> (f64, f64) {
        if self.settled || self.duration.is_zero() {
            self.settled = true;
            return self.end;
        }

        let elapsed = now.saturating_duration_since(self.started_at);
        if elapsed >= self.duration {
            self.settled = true;
            return self.end;
        }

        let t = elapsed.as_secs_f64() / self.duration.as_secs_f64();
        (
            lerp(self.start.0, self.end.0, t),
            lerp(self.start.1, self.end.1, t),
        )
    }
}

fn travel_duration(from: (f64, f64), to: (f64, f64)) -> Duration {
    let base = if is_fast_rim_destination(to) {
        FAST_TRAVEL
    } else {
        SLOW_TRAVEL
    };

    let magnitude = hypot(to);
    if magnitude > 1.0 + STICK_UNIT {
        scale_duration(base, magnitude)
    } else {
        let _ = from;
        base
    }
}

fn is_fast_rim_destination(point: (f64, f64)) -> bool {
    let magnitude = hypot(point);
    if magnitude < 1.0 - 2.0 * STICK_UNIT {
        return false;
    }

    let angle = octant_angle_deg(point);
    angle <= 3.0 || angle >= 87.0 || (DIAGONAL_MIN_DEG..=DIAGONAL_MAX_DEG).contains(&angle)
}

fn legalize_target(point: (f64, f64), shield: bool, traveling: bool) -> ((f64, f64), bool) {
    let mut x = point.0;
    let mut y = point.1;
    let mut instant = false;

    if hypot((x, y)) < STICK_UNIT {
        return ((0.0, 0.0), false);
    }

    // The two coordinates closest to each deadzone edge (24 and 25 units from
    // center on the axis holding the deadzone) cannot be targeted; nudge
    // targets onto the first legal coordinate (26 units) instead.
    if in_deadzone(x) && y.abs() > DEADZONE && y.abs() <= BANNED_NEAR_DEADZONE + STICK_UNIT {
        y = y.signum() * (BANNED_NEAR_DEADZONE + 2.0 * STICK_UNIT);
    }
    if in_deadzone(y) && x.abs() > DEADZONE && x.abs() <= BANNED_NEAR_DEADZONE + STICK_UNIT {
        x = x.signum() * (BANNED_NEAR_DEADZONE + 2.0 * STICK_UNIT);
    }

    if shield && in_deadzone(x) && (-SMASH_THRESHOLD..=-CROUCH_THRESHOLD).contains(&y) {
        y = -1.0;
    }

    let angle = octant_angle_deg((x, y));
    let from_axis = angle.min(90.0 - angle);
    let is_cardinal = from_axis < 1.0;
    let min_angle = if shield {
        MIN_SHIELD_ANGLE_DEG
    } else {
        MIN_FREE_ANGLE_DEG
    };

    if !is_cardinal && from_axis < min_angle {
        let mag = hypot((x, y));
        let lifted = if angle <= 45.0 {
            min_angle
        } else {
            90.0 - min_angle
        };
        let rad = lifted.to_radians();
        x = mag * rad.cos() * signum_or(point.0, 1.0);
        y = mag * rad.sin() * signum_or(point.1, 1.0);
        instant = shield && !traveling;
    }

    ((x, y), instant)
}

fn fuzz_target(target: (f64, f64), rng: &mut Lcg) -> (f64, f64) {
    if hypot(target) < STICK_UNIT {
        return (0.0, 0.0);
    }

    if is_unit_cardinal(target) {
        return target;
    }

    if in_deadzone(target.0) || in_deadzone(target.1) {
        return fuzz_deadzone(target, rng);
    }

    fuzz_neighborhood(target, rng)
}

fn fuzz_deadzone(target: (f64, f64), rng: &mut Lcg) -> (f64, f64) {
    let roll = rng.next_f64();
    let (axis_x, value) = if !in_deadzone(target.0) {
        (true, target.0)
    } else {
        (false, target.1)
    };

    let fuzzed = if roll < 0.5 {
        value
    } else if roll < 0.75 {
        value + STICK_UNIT * value.signum()
    } else {
        let closer = value.abs() - STICK_UNIT;
        closer.max(0.0) * value.signum()
    };

    if axis_x {
        (fuzzed, target.1)
    } else {
        (target.0, fuzzed)
    }
}

fn fuzz_neighborhood(target: (f64, f64), rng: &mut Lcg) -> (f64, f64) {
    let roll = rng.next_f64();
    if roll < 0.25 {
        return target;
    }

    let offsets = [
        (STICK_UNIT, 0.0),
        (-STICK_UNIT, 0.0),
        (0.0, STICK_UNIT),
        (0.0, -STICK_UNIT),
        (STICK_UNIT, STICK_UNIT),
        (STICK_UNIT, -STICK_UNIT),
        (-STICK_UNIT, STICK_UNIT),
        (-STICK_UNIT, -STICK_UNIT),
    ];

    if roll < 0.75 {
        let index = ((roll - 0.25) / 0.125).floor() as usize;
        add(target, offsets[index.min(3)])
    } else {
        let index = ((roll - 0.75) / 0.0625).floor() as usize;
        add(target, offsets[4 + index.min(3)])
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct MotionLockouts {
    last_crouch_at: Option<Instant>,
    last_dash_sign: i8,
    last_dash_diagonal: bool,
    last_pivot_at: Option<Instant>,
    last_pivot_from_diagonal_dash: bool,
    in_dtilt_since: Option<Instant>,
}

impl MotionLockouts {
    fn observe(&mut self, now: Instant, target: (f64, f64), context: NerfContext) {
        if is_crouch(target) {
            self.last_crouch_at = Some(now);
        }

        if is_dash(target) {
            let sign = sign_i8(target.0);
            if self.last_dash_sign != 0 && sign != 0 && sign != self.last_dash_sign {
                self.last_pivot_at = Some(now);
                self.last_pivot_from_diagonal_dash = self.last_dash_diagonal;
            }
            self.last_dash_sign = sign;
            self.last_dash_diagonal = !in_deadzone(target.1);
        } else if context.raw_horizontal != 0 && target.0.abs() >= DASH_THRESHOLD {
            self.last_dash_sign = context.raw_horizontal;
        }

        if is_dtilt(target) {
            self.in_dtilt_since.get_or_insert(now);
        } else {
            self.in_dtilt_since = None;
        }
    }

    fn force_target(&self, now: Instant, target: (f64, f64)) -> Option<(f64, f64)> {
        if is_utilt(target)
            && self
                .last_crouch_at
                .is_some_and(|at| now.saturating_duration_since(at) < CROUCH_UTILT_LOCK)
        {
            return Some((0.0, 1.0));
        }

        if let Some(pivot_at) = self.last_pivot_at {
            let since_pivot = now.saturating_duration_since(pivot_at);
            if since_pivot < DIAGONAL_DASH_PIVOT_LOCK
                && self.last_pivot_from_diagonal_dash
                && (is_utilt(target) || is_dtilt(target))
            {
                let sign = if target.0.abs() > STICK_UNIT {
                    signum_or(target.0, target.0)
                } else {
                    f64::from(self.last_dash_sign).max(-1.0)
                };
                return Some((FTILT * sign, 0.0));
            }

            if since_pivot < PIVOT_TILT_LOCK && target.1 > DEADZONE {
                return Some(extend_to_rim(target));
            }

            if since_pivot < PIVOT_TILT_LOCK && target.1 < -DEADZONE {
                let held_long_enough = self
                    .in_dtilt_since
                    .is_some_and(|at| now.saturating_duration_since(at) >= DTILT_BUFFER);
                if !held_long_enough {
                    return Some(extend_to_rim(target));
                }
            }
        }

        None
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum SdiZone {
    #[default]
    Neutral,
    Cardinal,
    Diagonal,
}

/// Burst-SDI lockout from the ruleset's timing lockouts:
///
/// * Rapidly tapping the same direction (cardinal or diagonal) and returning
///   to neutral faster than once every 5.5 frames triggers 1 SDI and ignores
///   subsequent attempts.
/// * Tapping a cardinal then rapidly alternating between the adjacent
///   diagonals faster than once every 5.5 frames triggers 1 cardinal SDI,
///   then 1 diagonal SDI, and ignores subsequent attempts.
///
/// Denied attempts hold the previous output coordinate until the 5.5-frame
/// window elapses.
#[derive(Clone, Copy, Debug)]
struct SdiLockout {
    zone: SdiZone,
    last_sdi_at: Option<Instant>,
    sdis_in_window: u8,
    first_zone: SdiZone,
    locked: bool,
    hold: (f64, f64),
}

impl Default for SdiLockout {
    fn default() -> Self {
        Self {
            zone: SdiZone::Neutral,
            last_sdi_at: None,
            sdis_in_window: 0,
            first_zone: SdiZone::Neutral,
            locked: false,
            hold: (0.0, 0.0),
        }
    }
}

impl SdiLockout {
    fn filter(&mut self, now: Instant, target: (f64, f64)) -> Option<(f64, f64)> {
        if self
            .last_sdi_at
            .is_some_and(|at| now.saturating_duration_since(at) >= SDI_LOCK)
        {
            self.last_sdi_at = None;
            self.sdis_in_window = 0;
            self.locked = false;
        }

        let zone = classify_sdi(target);
        if zone == SdiZone::Neutral {
            if self.zone != SdiZone::Neutral {
                self.hold = target;
            }
            self.zone = SdiZone::Neutral;
            return None;
        }

        if self.locked {
            // Ignore the attempt: hold the previous output coordinate.
            self.zone = zone;
            return Some(self.hold);
        }

        if zone != self.zone {
            let allowed = self.sdis_in_window == 0
                || (self.sdis_in_window == 1
                    && self.first_zone == SdiZone::Cardinal
                    && zone == SdiZone::Diagonal);
            self.zone = zone;

            if !allowed {
                self.locked = true;
                return Some(self.hold);
            }

            if self.sdis_in_window == 0 {
                self.first_zone = zone;
            }
            self.sdis_in_window += 1;
            self.last_sdi_at = Some(now);
        }

        self.hold = target;
        None
    }
}

#[derive(Clone, Debug)]
struct Lcg {
    state: u64,
}

impl Lcg {
    fn from_entropy() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15);
        Self { state: nanos | 1 }
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self
            .state
            .wrapping_mul(0x5851_F42D_4C95_7F2D)
            .wrapping_add(0x1405_7B7E_F767_814F);
        (self.state >> 32) as u32
    }

    fn next_f64(&mut self) -> f64 {
        f64::from(self.next_u32()) / f64::from(u32::MAX)
    }
}

fn in_deadzone(value: f64) -> bool {
    value.abs() <= DEADZONE
}

fn is_unit_cardinal(point: (f64, f64)) -> bool {
    (in_deadzone(point.0) && (point.1.abs() - 1.0).abs() <= 2.0 * STICK_UNIT)
        || (in_deadzone(point.1) && (point.0.abs() - 1.0).abs() <= 2.0 * STICK_UNIT)
}

fn is_crouch(point: (f64, f64)) -> bool {
    in_deadzone(point.0) && point.1 <= -CROUCH_THRESHOLD
}

fn is_dash(point: (f64, f64)) -> bool {
    point.0.abs() >= DASH_THRESHOLD
}

fn is_utilt(point: (f64, f64)) -> bool {
    in_deadzone(point.0) && point.1 > DEADZONE && point.1 < SMASH_THRESHOLD
}

fn is_dtilt(point: (f64, f64)) -> bool {
    in_deadzone(point.0) && point.1 < -DEADZONE && point.1 > -SMASH_THRESHOLD
}

fn classify_sdi(point: (f64, f64)) -> SdiZone {
    let x = point.0.abs() >= SMASH_THRESHOLD;
    let y = point.1.abs() >= SMASH_THRESHOLD;
    match (x, y) {
        (false, false) => SdiZone::Neutral,
        (true, true) => SdiZone::Diagonal,
        _ => SdiZone::Cardinal,
    }
}

fn octant_angle_deg(point: (f64, f64)) -> f64 {
    point.1.abs().atan2(point.0.abs()).to_degrees()
}

fn hypot(point: (f64, f64)) -> f64 {
    point.0.hypot(point.1)
}

fn lerp(start: f64, end: f64, t: f64) -> f64 {
    start + (end - start) * t
}

fn add(point: (f64, f64), delta: (f64, f64)) -> (f64, f64) {
    (point.0 + delta.0, point.1 + delta.1)
}

fn same_coord(lhs: (f64, f64), rhs: (f64, f64)) -> bool {
    (lhs.0 - rhs.0).abs() < 1e-9 && (lhs.1 - rhs.1).abs() < 1e-9
}

fn extend_to_rim(point: (f64, f64)) -> (f64, f64) {
    let mag = hypot(point);
    if mag < STICK_UNIT {
        (0.0, 1.0)
    } else {
        (point.0 / mag, point.1 / mag)
    }
}

fn sign_i8(value: f64) -> i8 {
    if value > STICK_UNIT {
        1
    } else if value < -STICK_UNIT {
        -1
    } else {
        0
    }
}

fn signum_or(value: f64, fallback: f64) -> f64 {
    if value.abs() > STICK_UNIT {
        value.signum()
    } else if fallback.abs() > STICK_UNIT {
        fallback.signum()
    } else {
        1.0
    }
}

fn scale_duration(base: Duration, factor: f64) -> Duration {
    Duration::from_secs_f64(base.as_secs_f64() * factor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_settings() -> NerfSettings {
        NerfSettings {
            travel_time: true,
            fuzzing: true,
            coordinate_limits: true,
            timing_lockouts: true,
        }
    }

    fn no_fuzz() -> NerfSettings {
        NerfSettings {
            fuzzing: false,
            ..all_settings()
        }
    }

    fn context() -> NerfContext {
        NerfContext {
            shield: false,
            b: false,
            raw_horizontal: 0,
        }
    }

    #[test]
    fn cardinal_rim_uses_fast_travel() {
        assert!(is_fast_rim_destination((1.0, 0.0)));
        assert!(is_fast_rim_destination((0.7, 0.7)));
        assert!(!is_fast_rim_destination((0.6625, 0.0)));
        assert!(!is_fast_rim_destination((0.7375, 0.3125)));
    }

    #[test]
    fn shallow_shield_angles_lock_to_27_degrees() {
        let (point, instant) = legalize_target((0.9, 0.2), true, false);
        let angle = octant_angle_deg(point);
        assert!(
            (angle - MIN_SHIELD_ANGLE_DEG).abs() < 0.05
                || (90.0 - angle - MIN_SHIELD_ANGLE_DEG).abs() < 0.05
        );
        assert!(instant);
    }

    #[test]
    fn shallow_free_angles_lock_to_20_degrees() {
        let (point, instant) = legalize_target((0.98, 0.1), false, false);
        let angle = octant_angle_deg(point);
        assert!((angle - MIN_FREE_ANGLE_DEG).abs() < 0.05);
        assert!(!instant);
    }

    #[test]
    fn banned_near_deadzone_targets_move_to_first_legal_coordinate() {
        let first_legal = BANNED_NEAR_DEADZONE + 2.0 * STICK_UNIT;

        let (point, _) = legalize_target((0.0, 0.3), false, false);
        assert!((point.1 - first_legal).abs() < 1e-9);

        let (point, _) = legalize_target((0.0, 0.3125), false, false);
        assert!((point.1 - first_legal).abs() < 1e-9);

        let (point, _) = legalize_target((first_legal, 0.0), false, false);
        assert!((point.0 - first_legal).abs() < 1e-9);
    }

    #[test]
    fn travel_to_cardinal_reaches_target_in_six_ms() {
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(start, (1.0, 0.0), context(), all_settings(), true);
        let mid = runtime.output;
        runtime.tick(start + Duration::from_millis(3));
        let halfway = runtime.output;
        runtime.tick(start + Duration::from_millis(6));
        assert!(mid.0.abs() < 0.05);
        assert!((halfway.0 - 0.5).abs() < 0.08);
        assert!((runtime.output.0 - 1.0).abs() < 1e-6);
        assert!(!runtime.is_traveling());
    }

    #[test]
    fn interior_targets_take_twelve_ms() {
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(start, (0.0, 0.7375), context(), no_fuzz(), true);
        runtime.tick(start + Duration::from_millis(11));
        assert!(runtime.is_traveling());
        runtime.tick(start + Duration::from_millis(12));
        assert!(!runtime.is_traveling());
        assert!((runtime.output.1 - 0.7375).abs() < 1e-6);
    }

    #[test]
    fn travel_time_disabled_outputs_target_immediately() {
        let settings = NerfSettings {
            travel_time: false,
            ..all_settings()
        };
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(start, (1.0, 0.0), context(), settings, true);
        assert!((runtime.output().0 - 1.0).abs() < 1e-9);
        assert!(!runtime.is_traveling());
    }

    #[test]
    fn fuzzing_disabled_outputs_exact_target() {
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(start, (0.0, 0.7375), context(), no_fuzz(), true);
        runtime.tick(start + SLOW_TRAVEL + Duration::from_millis(1));
        assert!((runtime.output().1 - 0.7375).abs() < 1e-9);
    }

    #[test]
    fn fuzzing_stays_within_one_unit_of_target() {
        let target = (0.7, 0.7);
        let mut rng = Lcg { state: 42 | 1 };
        for _ in 0..200 {
            let fuzzed = fuzz_target(target, &mut rng);
            assert!((fuzzed.0 - target.0).abs() <= STICK_UNIT + 1e-9);
            assert!((fuzzed.1 - target.1).abs() <= STICK_UNIT + 1e-9);
        }
    }

    #[test]
    fn unit_cardinals_are_never_fuzzed() {
        let mut rng = Lcg { state: 7 | 1 };
        for _ in 0..50 {
            assert_eq!(fuzz_target((1.0, 0.0), &mut rng), (1.0, 0.0));
            assert_eq!(fuzz_target((0.0, -1.0), &mut rng), (0.0, -1.0));
        }
    }

    #[test]
    fn coordinate_limits_disabled_keep_shallow_angle() {
        let settings = NerfSettings {
            coordinate_limits: false,
            fuzzing: false,
            ..all_settings()
        };
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(start, (0.9, 0.2), context(), settings, true);
        runtime.tick(start + SLOW_TRAVEL + Duration::from_millis(1));
        assert!((runtime.output().0 - 0.9).abs() < 1e-9);
        assert!((runtime.output().1 - 0.2).abs() < 1e-9);
    }

    #[test]
    fn reverse_neutral_b_forces_tilt_side_b() {
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(
            start,
            (0.3375, 0.0),
            NerfContext {
                shield: false,
                b: true,
                raw_horizontal: 1,
            },
            no_fuzz(),
            true,
        );
        assert!((runtime.output().0 - TILT_SIDE_B).abs() < 1e-9);
        assert!(runtime.output().1.abs() < 1e-9);
    }

    #[test]
    fn reverse_neutral_b_lockout_can_be_disabled() {
        let settings = NerfSettings {
            coordinate_limits: false,
            fuzzing: false,
            ..all_settings()
        };
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(
            start,
            (0.3375, 0.0),
            NerfContext {
                shield: false,
                b: true,
                raw_horizontal: 1,
            },
            settings,
            true,
        );
        runtime.tick(start + SLOW_TRAVEL + Duration::from_millis(1));
        assert!((runtime.output().0 - 0.3375).abs() < 1e-9);
    }

    #[test]
    fn crouch_to_utilt_lockout_forces_u_smash() {
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();

        runtime.apply(start, (0.0, -0.7), context(), no_fuzz(), true);
        runtime.apply(
            start + Duration::from_millis(20),
            (0.0, 0.5),
            context(),
            no_fuzz(),
            true,
        );
        assert!((runtime.output().1 - 1.0).abs() < 1e-9);

        // After the 3-frame window the u-tilt coordinate is reachable again.
        runtime.apply(
            start + Duration::from_millis(100),
            (0.0, -0.7),
            context(),
            no_fuzz(),
            true,
        );
        runtime.apply(
            start + Duration::from_millis(160),
            (0.0, 0.5),
            context(),
            no_fuzz(),
            true,
        );
        runtime.tick(start + Duration::from_millis(175));
        assert!((runtime.output().1 - 0.5).abs() < 1e-9);
    }

    #[test]
    fn timing_lockouts_disabled_skip_crouch_utilt_lockout() {
        let settings = NerfSettings {
            timing_lockouts: false,
            fuzzing: false,
            ..all_settings()
        };
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        runtime.apply(start, (0.0, -0.7), context(), settings, true);
        runtime.apply(
            start + Duration::from_millis(20),
            (0.0, 0.5),
            context(),
            settings,
            true,
        );
        runtime.tick(start + Duration::from_millis(100));
        assert!((runtime.output().1 - 0.5).abs() < 1e-9);
    }

    #[test]
    fn sdi_lockout_ignores_rapid_same_direction_taps() {
        let mut lockout = SdiLockout::default();
        let start = Instant::now();
        let right = (0.9, 0.0);
        let neutral = (0.0, 0.0);

        // First tap produces an SDI (output passes through).
        assert_eq!(lockout.filter(start, right), None);
        assert_eq!(
            lockout.filter(start + Duration::from_millis(8), neutral),
            None
        );

        // Second tap inside the 5.5-frame window is ignored.
        let denied = lockout.filter(start + Duration::from_millis(16), right);
        assert_eq!(denied, Some(neutral));

        // Still ignored later inside the window.
        let denied = lockout.filter(start + Duration::from_millis(80), right);
        assert_eq!(denied, Some(neutral));

        // Returning to neutral passes through even while locked.
        assert_eq!(
            lockout.filter(start + Duration::from_millis(84), neutral),
            None
        );

        // Once the 5.5-frame window elapses, tapping works again.
        assert_eq!(
            lockout.filter(start + Duration::from_millis(100), right),
            None
        );
    }

    #[test]
    fn sdi_lockout_allows_one_cardinal_then_one_diagonal() {
        let mut lockout = SdiLockout::default();
        let start = Instant::now();
        let cardinal = (0.9, 0.0);
        let diagonal = (0.7, 0.7);

        assert_eq!(lockout.filter(start, cardinal), None);
        assert_eq!(
            lockout.filter(start + Duration::from_millis(4), diagonal),
            None
        );

        // The next alternation attempt is ignored and holds the diagonal.
        let denied = lockout.filter(start + Duration::from_millis(8), cardinal);
        assert_eq!(denied, Some(diagonal));
        let denied = lockout.filter(start + Duration::from_millis(12), diagonal);
        assert_eq!(denied, Some(diagonal));
    }

    #[test]
    fn sdi_lockout_is_inactive_when_timing_lockouts_disabled() {
        let settings = NerfSettings {
            timing_lockouts: false,
            fuzzing: false,
            ..all_settings()
        };
        let mut runtime = NerfRuntime::default();
        let start = Instant::now();
        for index in 0..5u64 {
            let at = start + Duration::from_millis(index * 4);
            let target = if index % 2 == 0 {
                (0.9, 0.0)
            } else {
                (0.0, 0.0)
            };
            runtime.apply(at, target, context(), settings, true);
        }
        runtime.tick(start + Duration::from_millis(40));
        // Rapid alternating never holds the output: it rests at the cardinal.
        assert!((runtime.output().0 - 0.9).abs() < 1e-9);
        assert!(runtime.output().1.abs() < 1e-9);
    }
}
