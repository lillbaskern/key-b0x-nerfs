mod binding;
mod config;
mod coords;
mod engine;
mod nerfs;
mod socd;

pub use binding::{BindingId, ControllerSnapshot, InputEvent};
pub use config::{
    AirdodgeConfig, DownDiagonalBehavior, HorizontalSocdOverride, MeleeConfig, MeleeConfigError,
    NerfConfig, SocdConfig, SocdMode,
};
pub use engine::MeleeEngine;

pub type B0xxEngine = MeleeEngine;
