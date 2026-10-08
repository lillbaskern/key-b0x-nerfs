use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MeleeConfig {
    pub socd: SocdConfig,
    pub down_diagonal: DownDiagonalBehavior,
    pub horizontal_socd_override: HorizontalSocdOverride,
    pub airdodge: AirdodgeConfig,
    pub nerfs: NerfConfig,
}

impl Default for MeleeConfig {
    fn default() -> Self {
        Self {
            socd: SocdConfig::default(),
            down_diagonal: DownDiagonalBehavior::default(),
            horizontal_socd_override: HorizontalSocdOverride::default(),
            airdodge: AirdodgeConfig::default(),
            nerfs: NerfConfig::default(),
        }
    }
}

/// Rectangle controller nerfs from the Melee controller ruleset proposal.
///
/// Each flag maps to one of the mandated nerf families:
/// `travel_time` (travel time simulation), `fuzzing` (output fuzzing),
/// `coordinate_limits` (limits on target coordinates, including the L/R angle
/// lockout and reverse neutral-B lockout) and `timing_lockouts` (SDI and
/// pivot/crouch timing lockouts). `enabled` gates all of them at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NerfConfig {
    pub enabled: bool,
    pub travel_time: bool,
    pub fuzzing: bool,
    pub coordinate_limits: bool,
    pub timing_lockouts: bool,
}

impl Default for NerfConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            travel_time: true,
            fuzzing: true,
            coordinate_limits: true,
            timing_lockouts: true,
        }
    }
}

impl NerfConfig {
    pub const fn disabled() -> Self {
        Self {
            enabled: false,
            travel_time: false,
            fuzzing: false,
            coordinate_limits: false,
            timing_lockouts: false,
        }
    }
}

impl MeleeConfig {
    pub fn validate(&self) -> Result<(), MeleeConfigError> {
        if let AirdodgeConfig::CustomModXDiagonal { x, y } = self.airdodge {
            if !(0.0..=1.0).contains(&x) || x == 0.0 {
                return Err(MeleeConfigError::InvalidCustomAirdodgeAxis {
                    axis: "x",
                    value: x,
                });
            }
            if !(0.0..=1.0).contains(&y) || y == 0.0 {
                return Err(MeleeConfigError::InvalidCustomAirdodgeAxis {
                    axis: "y",
                    value: y,
                });
            }
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SocdConfig {
    pub main_x: SocdMode,
    pub main_y: SocdMode,
    pub c_x: SocdMode,
    pub c_y: SocdMode,
}

impl Default for SocdConfig {
    fn default() -> Self {
        Self {
            main_x: SocdMode::Neutral,
            main_y: SocdMode::Neutral,
            c_x: SocdMode::Neutral,
            c_y: SocdMode::Neutral,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SocdMode {
    Neutral,
    SecondInputPriority,
    SecondInputPriorityNoReactivation,
    Dir1Priority,
    Dir2Priority,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownDiagonalBehavior {
    #[default]
    AutoJabCancel,
    CrouchWalkOs,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HorizontalSocdOverride {
    #[default]
    MaxJumpTrajectory,
    Disabled,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AirdodgeConfig {
    Default,
    CustomModXDiagonal { x: f64, y: f64 },
}

impl Default for AirdodgeConfig {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Debug, Error)]
pub enum MeleeConfigError {
    #[error("custom airdodge {axis} must be within (0.0, 1.0], got {value}")]
    InvalidCustomAirdodgeAxis { axis: &'static str, value: f64 },
}
