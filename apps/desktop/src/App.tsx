import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import {
  BINDING_GROUPS,
  DEFAULT_BINDINGS,
  DEFAULT_MELEE_CONFIG,
  type AppConfig,
  cloneMeleeConfig,
  type BindingId,
  type BindingMap,
  type DownDiagonalBehavior,
  type HorizontalSocdOverride,
  type KeyboardTestState,
  type MeleeConfig,
  type NormalizedKey,
  type RuntimeState,
  type SocdMode,
  type SetupStatus,
  type UpdateState,
  findDuplicateBindings,
  formatBindingLabel,
  formatKeyLabel,
  isNormalizedKey,
  layoutKeyLabel
} from '../shared/model';

type AppView = 'onboarding' | 'dashboard';
type OnboardingStep = 'path' | 'profile' | 'keyboard';
type ToastTone = 'info' | 'success' | 'warning' | 'error';
type KeyboardTestSource = 'onboarding' | 'settings';

type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

type MeleeSettingsDraft = {
  socd_mode: SocdMode;
  down_diagonal: DownDiagonalBehavior;
  horizontal_socd_override: HorizontalSocdOverride;
  airdodge_kind: MeleeConfig['airdodge']['kind'];
  airdodge_x: string;
  airdodge_y: string;
  nerfs_enabled: boolean;
  nerfs_travel_time: boolean;
  nerfs_fuzzing: boolean;
  nerfs_coordinate_limits: boolean;
  nerfs_timing_lockouts: boolean;
};

type NerfToggleField =
  | 'nerfs_travel_time'
  | 'nerfs_fuzzing'
  | 'nerfs_coordinate_limits'
  | 'nerfs_timing_lockouts';

type SelectOption<T extends string> = {
  value: T;
  label: string;
  detail?: string;
  tag?: string;
};

const IDLE_RUNTIME: RuntimeState = {
  status: 'idle',
  startedAt: null,
  lastError: null
};
const IDLE_KEYBOARD_TEST: KeyboardTestState = {
  status: 'idle',
  pressedKeys: [],
  lastError: null
};
const IDLE_UPDATE_STATE: UpdateState = {
  status: 'idle',
  currentVersion: '',
  latestVersion: null,
  notes: null,
  publishedAt: null,
  target: null,
  downloadedBytes: null,
  contentLength: null,
  lastError: null
};
const TOAST_LIFETIME_MS = 3200;
const WAITING_FOR_SLIPPI_TOAST_ID = -1;
const SOCD_MODE_OPTIONS: SelectOption<SocdMode>[] = [
  {
    value: 'neutral',
    label: 'Neutral',
    detail: 'Opposites cancel out',
    tag: 'Default'
  },
  {
    value: 'second_input_priority_no_reactivation',
    label: '2IP No Reactivation',
    detail: 'Release the newer opposite direction: stay neutral until the held direction is re-pressed'
  },
  {
    value: 'second_input_priority',
    label: '2IP Reactivation',
    detail: 'Release the newer opposite direction: return to the direction still held'
  },
  {
    value: 'dir1_priority',
    label: 'Dir1 Priority',
    detail: 'First direction wins'
  },
  {
    value: 'dir2_priority',
    label: 'Dir2 Priority',
    detail: 'Second direction wins'
  }
];
const DOWN_DIAGONAL_OPTIONS: SelectOption<DownDiagonalBehavior>[] = [
  {
    value: 'auto_jab_cancel',
    label: 'Auto Jab Cancel',
    detail: 'Standard down-diagonal behavior',
    tag: 'Default'
  },
  {
    value: 'crouch_walk_os',
    label: 'Crouch Walk OS',
    detail: 'Favor crouch walk option select'
  }
];
const HORIZONTAL_SOCD_OVERRIDE_OPTIONS: SelectOption<HorizontalSocdOverride>[] = [
  {
    value: 'max_jump_trajectory',
    label: 'Max Jump Trajectory',
    detail: 'Preserve the jump arc',
    tag: 'Default'
  },
  {
    value: 'disabled',
    label: 'Disabled',
    detail: 'Use raw horizontal SOCD'
  }
];
const AIRDODGE_KIND_OPTIONS: SelectOption<MeleeSettingsDraft['airdodge_kind']>[] = [
  {
    value: 'default',
    label: 'Default',
    detail: 'Standard runtime diagonal',
    tag: 'Default'
  },
  {
    value: 'custom_mod_x_diagonal',
    label: 'Custom Mod-X Shield Diagonal',
    detail: 'Tune the custom X/Y diagonal'
  }
];
const NERF_MASTER_OPTIONS: SelectOption<'enabled' | 'disabled'>[] = [
  {
    value: 'enabled',
    label: 'Enabled',
    detail: 'Apply the rectangle nerfs from the Melee controller ruleset proposal',
    tag: 'Ruleset'
  },
  {
    value: 'disabled',
    label: 'Disabled',
    detail: 'Raw coordinates: no travel time, fuzzing, coordinate limits, or lockouts'
  }
];
const NERF_TOGGLE_ROWS: { field: NerfToggleField; label: string; detail: string }[] = [
  {
    field: 'nerfs_travel_time',
    label: 'Travel Time Simulation',
    detail: 'Linear 6 ms to rim cardinals/diagonals and 12 ms to everything else, matching very fast analog sticks.'
  },
  {
    field: 'nerfs_fuzzing',
    label: 'Output Fuzzing',
    detail: 'Nudges output by 1 unit so single coordinates cannot be targeted consistently.'
  },
  {
    field: 'nerfs_coordinate_limits',
    label: 'Coordinate Limits',
    detail: 'Enforces the 20°/27° angle limits, bans the coordinates next to the deadzone, and forces tilt side-B out of neutral-B.'
  },
  {
    field: 'nerfs_timing_lockouts',
    label: 'Timing Lockouts',
    detail: 'Caps burst SDI and delays crouch/pivot tilts so buttons cannot beat analog stick timings.'
  }
];

function App() {
  const [appView, setAppView] = useState<AppView>('onboarding');
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('path');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [bindingDraft, setBindingDraft] = useState<BindingMap | null>(null);
  const [meleeDraft, setMeleeDraft] = useState<MeleeSettingsDraft | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState>(IDLE_RUNTIME);
  const [keyboardTest, setKeyboardTest] = useState<KeyboardTestState>(IDLE_KEYBOARD_TEST);
  const [updateState, setUpdateState] = useState<UpdateState>(IDLE_UPDATE_STATE);
  const [keyboardTestOpen, setKeyboardTestOpen] = useState(false);
  const [keyboardTestSource, setKeyboardTestSource] = useState<KeyboardTestSource | null>(null);
  const [keyboardTestBusy, setKeyboardTestBusy] = useState(false);
  // The busy guard, resume intent, and queued close requests are tracked in
  // refs as well: React state updates are asynchronous, so two same-tick
  // events (Escape + blur, rapid clicks) would otherwise both observe a stale
  // `false` guard and run concurrently.
  const keyboardTestBusyRef = useRef(false);
  const keyboardTestResumeRuntimeRef = useRef(false);
  const keyboardTestCloseRequestedRef = useRef(false);
  const [slippiPathDraft, setSlippiPathDraft] = useState('');
  const [captureTarget, setCaptureTarget] = useState<BindingId | null>(null);
  const [keyboardLayout, setKeyboardLayout] = useState<ReadonlyMap<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const nextToastId = useRef(0);
  const toastTimeouts = useRef(new Map<number, number>());
  const hasAutoCheckedForUpdates = useRef(false);

  // Keep key labels in sync with the OS keyboard layout so bindings show the
  // characters printed on the user's keycaps (e.g. "å" instead of the US
  // ";"). Falls back to US labels when the webview lacks the Keyboard API.
  useEffect(() => {
    const keyboard = navigator.keyboard;
    if (!keyboard) {
      return;
    }

    let cancelled = false;
    const refreshLayout = () => {
      void keyboard
        .getLayoutMap()
        .then((layoutMap) => {
          if (!cancelled) {
            setKeyboardLayout(layoutMap);
          }
        })
        .catch(() => {
          // Keep US fallback labels.
        });
    };

    refreshLayout();
    // Also refresh when the window regains focus: users typically switch
    // keyboard layouts with a hotkey while the app is in the background.
    window.addEventListener('focus', refreshLayout);
    // The spec's layoutchange event is not implemented in all webviews
    // (WebView2 exposes a Keyboard object without EventTarget methods), so
    // only subscribe when actually available.
    if (typeof keyboard.addEventListener === 'function') {
      keyboard.addEventListener('layoutchange', refreshLayout);
    }

    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshLayout);
      if (typeof keyboard.removeEventListener === 'function') {
        keyboard.removeEventListener('layoutchange', refreshLayout);
      }
    };
  }, []);

  const keyLabel = (key: NormalizedKey): string =>
    layoutKeyLabel(key, keyboardLayout ?? undefined);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
        const [
          loadedConfig,
          loadedRuntimeState,
          loadedKeyboardTestState,
          currentAppVersion
        ] = await Promise.all([
          api.getConfig(),
          api.getRuntimeState(),
          api.getKeyboardTestState(),
          api.getAppVersion()
        ]);

        if (!mounted) {
          return;
        }

        const setupStatus = await api.checkSetup();
        if (!mounted) {
          return;
        }

        const initialRoute = getInitialRoute(loadedConfig, setupStatus);
        const initialOnboardingStep = getInitialOnboardingStep(loadedConfig, setupStatus);

        setConfig(cloneConfig(loadedConfig));
        setBindingDraft({ ...loadedConfig.bindings });
        setMeleeDraft(meleeDraftFromConfig(loadedConfig.melee));
        setSlippiPathDraft(loadedConfig.slippi_user_path);
        setRuntime(loadedRuntimeState);
        setKeyboardTest(loadedKeyboardTestState);
        setUpdateState({
          ...IDLE_UPDATE_STATE,
          currentVersion: currentAppVersion
        });
        setSetup(setupStatus);
        setAppView(initialRoute);
        setOnboardingStep(initialOnboardingStep);

        if (
          initialRoute === 'dashboard' &&
          (loadedRuntimeState.status === 'idle' || loadedRuntimeState.status === 'error') &&
          setupStatus.slippiFound &&
          setupStatus.profileInstalled &&
          findDuplicateBindings(loadedConfig.bindings).length === 0
        ) {
          setBusyAction('auto-start-runtime');

          try {
            await api.startRuntime();
          } catch (error) {
            if (mounted) {
              setScreenError(messageFromError(error));
            }
          } finally {
            if (mounted) {
              setBusyAction(null);
            }
          }
        }
      } catch (error) {
        if (mounted) {
          setScreenError(messageFromError(error));
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void bootstrap();

    const unsubscribe = api.onRuntimeState((nextRuntimeState) => {
      setRuntime(nextRuntimeState);
      if (nextRuntimeState.status === 'error') {
        setAppView('dashboard');
      }
    });
    const unsubscribeKeyboardTest = api.onKeyboardTestState((nextKeyboardTestState) => {
      setKeyboardTest(nextKeyboardTestState);
    });
    const unsubscribeUpdater = api.onUpdateState((nextUpdateState) => {
      setUpdateState(nextUpdateState);
    });

    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeKeyboardTest();
      unsubscribeUpdater();
    };
  }, []);

  useEffect(() => {
    if (loading || hasAutoCheckedForUpdates.current || updateState.currentVersion.length === 0) {
      return;
    }

    hasAutoCheckedForUpdates.current = true;
    void handleCheckForUpdates(true);
  }, [loading, updateState.currentVersion]);

  useEffect(() => {
    return () => {
      for (const timeoutId of toastTimeouts.current.values()) {
        window.clearTimeout(timeoutId);
      }

      toastTimeouts.current.clear();
    };
  }, []);

  function dismissToast(id: number) {
    const timeoutId = toastTimeouts.current.get(id);

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      toastTimeouts.current.delete(id);
    }

    setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== id));
  }

  function pushToast(message: string, tone: ToastTone = 'info') {
    nextToastId.current += 1;
    const id = nextToastId.current;

    setToasts((currentToasts) => [...currentToasts, { id, message, tone }]);

    const timeoutId = window.setTimeout(() => {
      toastTimeouts.current.delete(id);
      setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== id));
    }, TOAST_LIFETIME_MS);

    toastTimeouts.current.set(id, timeoutId);
  }

  useEffect(() => {
    if (!captureTarget) {
      return;
    }

    const target = captureTarget;

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') {
        setCaptureTarget(null);
        pushToast('Rebind cancelled.');
        return;
      }

      if (!isNormalizedKey(event.code)) {
        return;
      }

      setBindingDraft((currentDraft) => {
        if (!currentDraft) {
          return currentDraft;
        }

        return {
          ...currentDraft,
          [target]: event.code
        };
      });
      setCaptureTarget(null);
      pushToast(`Assigned ${formatBindingLabel(target)} to ${keyLabel(event.code)}.`);
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [captureTarget, keyboardLayout]);

  const runtimeLocked = isRuntimeLocked(runtime.status);
  const meleeLocked =
    busyAction === 'save-melee' ||
    busyAction === 'apply-setup' ||
    runtime.status === 'starting' ||
    runtime.status === 'stopping';
  const bindingsLocked =
    busyAction === 'save-bindings' ||
    busyAction === 'apply-setup' ||
    runtime.status === 'starting' ||
    runtime.status === 'stopping';
  const setupDirty = Boolean(config) && slippiPathDraft.trim() !== config?.slippi_user_path;
  const duplicateGroups = useMemo(
    () => (bindingDraft ? findDuplicateBindings(bindingDraft) : []),
    [bindingDraft]
  );
  const duplicateBindings = useMemo(
    () => new Set(duplicateGroups.flatMap((group) => group.bindings)),
    [duplicateGroups]
  );
  const bindingsDirty = Boolean(
    config && bindingDraft && !bindingMapsEqual(config.bindings, bindingDraft)
  );
  const meleeDirty = Boolean(config && meleeDraft && !meleeDraftMatchesConfig(meleeDraft, config.melee));
  const meleeValidationMessage = useMemo(
    () => (meleeDraft ? validateMeleeDraft(meleeDraft) : null),
    [meleeDraft]
  );
  const setupComplete = Boolean(setup?.slippiFound && setup?.profileInstalled);
  const bindingsReady = duplicateGroups.length === 0 && !bindingsDirty;
  const configurationReady = setupComplete && !setupDirty && bindingsReady;
  const dashboardNotice = getDashboardNotice({
    setupComplete,
    duplicateGroups,
    keyLabel
  });
  const updateAvailable =
    updateState.status === 'available' ||
    (updateState.status === 'error' && Boolean(updateState.latestVersion) && !updateState.downloadedBytes);
  const updateReady =
    updateState.status === 'downloaded' ||
    (updateState.status === 'error' && Boolean(updateState.downloadedBytes));

  useEffect(() => {
    if (!settingsOpen || appView !== 'dashboard' || keyboardTestOpen) {
      return;
    }

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void closeSettings();
    }

    window.addEventListener('keydown', handleDialogKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleDialogKeyDown, true);
    };
  }, [settingsOpen, appView, configurationReady, runtime.status, keyboardTestOpen]);

  useEffect(() => {
    if (!keyboardTestOpen) {
      return;
    }

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void closeKeyboardTest();
    }

    window.addEventListener('keydown', handleDialogKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleDialogKeyDown, true);
    };
  }, [keyboardTestOpen]);

  useEffect(() => {
    if (!keyboardTestOpen) {
      return;
    }

    // Clicking away from key-b0x (for example onto the game) must not leave
    // the runtime paused: close the test and resume as soon as the window
    // loses focus.
    function handleWindowBlur() {
      void closeKeyboardTest();
    }

    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [keyboardTestOpen]);

  async function refreshSetup() {
    const nextSetup = await api.checkSetup();
    setSetup(nextSetup);
    return nextSetup;
  }

  async function startRuntimeForDashboard() {
    setBusyAction('auto-start-runtime');
    setScreenError(null);

    try {
      await api.startRuntime();
      setAppView('dashboard');
    } catch (error) {
      setScreenError(messageFromError(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApplySetup(): Promise<boolean> {
    if (!config) {
      return false;
    }

    const nextPath = slippiPathDraft.trim();
    if (nextPath.length === 0) {
      setScreenError('Slippi user path cannot be empty.');
      return false;
    }

    const pathChanged = nextPath !== config.slippi_user_path;

    setBusyAction('apply-setup');
    setScreenError(null);

    try {
      const shouldRestartRuntime = isRuntimeLive(runtime.status);
      const savedConfig = await api.saveConfig({
        ...config,
        slippi_user_path: nextPath
      });

      setConfig((currentConfig) =>
        currentConfig
          ? {
              ...currentConfig,
              slippi_user_path: savedConfig.slippi_user_path
            }
          : cloneConfig(savedConfig)
      );
      setSlippiPathDraft(savedConfig.slippi_user_path);
      await api.installProfile();
      const nextSetup = await refreshSetup();

      if (shouldRestartRuntime) {
        await api.stopRuntime();
        await api.startRuntime();
      }

      pushToast(pathChanged ? 'Updated.' : 'Installed.', 'success');
      return nextSetup.slippiFound && nextSetup.profileInstalled;
    } catch (error) {
      setScreenError(messageFromError(error));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReinstallProfile() {
    setBusyAction('reinstall-profile');
    setScreenError(null);

    try {
      await api.installProfile();
      await refreshSetup();
      pushToast('Controller profile reset.', 'success');
    } catch (error) {
      // Surface the failure as a toast: the screen-error banner lives on the
      // dashboard, behind the open settings modal.
      pushToast(messageFromError(error), 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveBindings() {
    if (!config || !bindingDraft) {
      return;
    }

    if (duplicateGroups.length > 0) {
      setScreenError(duplicateMessage(duplicateGroups[0], keyLabel));
      return;
    }

    setBusyAction('save-bindings');
    setScreenError(null);

    try {
      const shouldRestartRuntime = !settingsOpen && isRuntimeLive(runtime.status);
      const shouldStartRuntime =
        !settingsOpen &&
        !shouldRestartRuntime &&
        setupComplete &&
        !setupDirty &&
        duplicateGroups.length === 0 &&
        (runtime.status === 'idle' || runtime.status === 'error');

      const savedConfig = await api.saveConfig({
        ...config,
        bindings: bindingDraft
      });

      setConfig(cloneConfig(savedConfig));
      setBindingDraft({ ...savedConfig.bindings });

      if (shouldRestartRuntime) {
        await api.stopRuntime();
        await api.startRuntime();
      } else if (shouldStartRuntime) {
        await api.startRuntime();
      }

      pushToast('Bindings saved.', 'success');
    } catch (error) {
      setScreenError(messageFromError(error));
    } finally {
      setBusyAction(null);
    }
  }

  function handleRestoreDefaults() {
    setBindingDraft({ ...DEFAULT_BINDINGS });
    pushToast('Restored default bindings. Save to keep them.');
  }

  async function handleSaveMelee() {
    if (!config || !meleeDraft) {
      return;
    }

    const validationMessage = validateMeleeDraft(meleeDraft);
    if (validationMessage) {
      return;
    }

    const meleeConfig = meleeConfigFromDraft(meleeDraft);
    setBusyAction('save-melee');
    setScreenError(null);

    try {
      const shouldRestartRuntime = isRuntimeLive(runtime.status);
      const savedConfig = await api.saveConfig({
        ...config,
        melee: meleeConfig
      });

      setConfig((currentConfig) =>
        currentConfig
          ? {
              ...currentConfig,
              melee: cloneMeleeConfig(savedConfig.melee)
            }
          : cloneConfig(savedConfig)
      );
      setMeleeDraft(meleeDraftFromConfig(savedConfig.melee));

      if (shouldRestartRuntime) {
        await api.stopRuntime();
        await api.startRuntime();
      }

      pushToast('Melee settings saved.', 'success');
    } catch (error) {
      setScreenError(messageFromError(error));
    } finally {
      setBusyAction(null);
    }
  }

  function handleRestoreDefaultMelee() {
    setMeleeDraft(meleeDraftFromConfig(DEFAULT_MELEE_CONFIG));
    pushToast('Restored default melee settings. Save to keep them.');
  }

  async function handleBrowseSlippiPath() {
    try {
      const pickedPath = await api.pickSlippiUserPath(slippiPathDraft);

      if (pickedPath) {
        setSlippiPathDraft(pickedPath);
      }
    } catch (error) {
      setScreenError(messageFromError(error));
    }
  }

  async function handleCheckForUpdates(silent = false) {
    setBusyAction('check-for-update');

    try {
      await api.checkForUpdate();
    } catch (error) {
      if (!silent) {
        pushToast('Update check failed.', 'error');
      }
    } finally {
      setBusyAction((currentAction) =>
        currentAction === 'check-for-update' ? null : currentAction
      );
    }
  }

  async function handleDownloadUpdate() {
    setBusyAction('download-update');

    try {
      await api.downloadUpdate();
      pushToast('Update downloaded.', 'success');
    } catch (error) {
      void error;
    } finally {
      setBusyAction((currentAction) =>
        currentAction === 'download-update' ? null : currentAction
      );
    }
  }

  async function handleInstallUpdate() {
    const installingOnWindows = isWindows();

    if (installingOnWindows) {
      pushToast('App will close briefly while the installer runs.', 'warning');
    }

    setBusyAction('install-update');

    try {
      await api.installUpdate();
    } catch (error) {
      void error;
    } finally {
      setBusyAction((currentAction) =>
        currentAction === 'install-update' ? null : currentAction
      );
    }
  }

  function openSettings() {
    setSettingsOpen(true);
    setCaptureTarget(null);
  }

  async function openKeyboardTest(source: KeyboardTestSource) {
    if (keyboardTestBusyRef.current || runtime.status === 'starting' || runtime.status === 'stopping') {
      return;
    }

    keyboardTestBusyRef.current = true;
    setKeyboardTestBusy(true);
    setKeyboardTestOpen(true);
    setKeyboardTestSource(source);
    keyboardTestResumeRuntimeRef.current = false;
    setKeyboardTest(IDLE_KEYBOARD_TEST);

    const shouldResumeRuntime = source === 'settings' && isRuntimeLive(runtime.status);
    // Record the resume intent before the awaited stop: if the stop fails
    // midway the runtime may still have gone down, and restarting a live
    // runtime is a no-op on the backend.
    keyboardTestResumeRuntimeRef.current = shouldResumeRuntime;

    try {
      if (shouldResumeRuntime) {
        await api.stopRuntime();
      }

      await api.startKeyboardTest();
      // Runtime and keyboard-test state are applied exclusively through the
      // listeners registered at mount: command responses travel on a
      // different IPC channel than state events and may arrive after newer
      // events, so applying them would regress the UI to a stale snapshot
      // (for example showing "Starting" after the worker reported "Running").
    } catch (error) {
      setKeyboardTest({
        status: 'error',
        pressedKeys: [],
        lastError: messageFromError(error)
      });
    } finally {
      keyboardTestBusyRef.current = false;
      setKeyboardTestBusy(false);

      // A close requested while this open was in flight (for example the
      // window losing focus) runs now that the open has settled.
      if (keyboardTestCloseRequestedRef.current) {
        keyboardTestCloseRequestedRef.current = false;
        void closeKeyboardTest();
      }
    }
  }

  async function closeKeyboardTest() {
    if (keyboardTestBusyRef.current) {
      keyboardTestCloseRequestedRef.current = true;
      return;
    }

    const shouldResumeRuntime = keyboardTestResumeRuntimeRef.current;
    keyboardTestResumeRuntimeRef.current = false;
    keyboardTestBusyRef.current = true;
    setKeyboardTestBusy(true);

    try {
      await api.stopKeyboardTest();
    } catch (error) {
      setScreenError(messageFromError(error));
    }

    setKeyboardTestOpen(false);
    setKeyboardTestSource(null);
    setKeyboardTest(IDLE_KEYBOARD_TEST);

    if (shouldResumeRuntime) {
      try {
        await api.startRuntime();
      } catch (error) {
        setScreenError(messageFromError(error));
      }
    }

    // This close satisfies any request queued while it ran.
    keyboardTestCloseRequestedRef.current = false;
    keyboardTestBusyRef.current = false;
    setKeyboardTestBusy(false);
  }

  async function closeSettings() {
    if (keyboardTestOpen && keyboardTestSource === 'settings') {
      await closeKeyboardTest();
    }

    setSettingsOpen(false);
    setCaptureTarget(null);

    if (configurationReady && (runtime.status === 'idle' || runtime.status === 'error')) {
      await startRuntimeForDashboard();
    }
  }

  async function toggleSettings() {
    if (settingsOpen) {
      await closeSettings();
      return;
    }

    openSettings();
  }

  async function enterDashboardFromOnboarding() {
    if (keyboardTestOpen) {
      await closeKeyboardTest();
    }

    setCaptureTarget(null);
    setSettingsOpen(false);
    setOnboardingStep('path');
    setAppView('dashboard');

    if (bindingsReady && (runtime.status === 'idle' || runtime.status === 'error')) {
      await startRuntimeForDashboard();
    }
  }

  async function completeOnboarding() {
    if (!config) {
      return;
    }

    setBusyAction('complete-onboarding');
    setScreenError(null);

    try {
      const savedConfig = await api.saveConfig({
        ...config,
        onboarding_completed: true
      });

      setConfig(cloneConfig(savedConfig));
      await enterDashboardFromOnboarding();
    } catch (error) {
      setScreenError(messageFromError(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function goToNextStep() {
    if (onboardingStep === 'path') {
      const setupReady = await handleApplySetup();

      if (!setupReady) {
        return;
      }

      if (config?.onboarding_completed) {
        await enterDashboardFromOnboarding();
        return;
      }

      setOnboardingStep('profile');
      return;
    }

    if (onboardingStep === 'profile') {
      setOnboardingStep('keyboard');
      return;
    }

    await completeOnboarding();
  }

  async function goToPreviousStep() {
    if (keyboardTestOpen) {
      await closeKeyboardTest();
    }

    setOnboardingStep((currentStep) => {
      if (currentStep === 'keyboard') {
        return 'profile';
      }

      return 'path';
    });
  }

  if (loading || !config || !bindingDraft || !meleeDraft || !setup) {
    return (
      <div className="app-shell">
        <div className="app-backdrop" />
        <div className="loading-shell">
          <div className="loading-mark">
            <div className="app-badge">key-b0x</div>
            <h1>Loading</h1>
            <p>Opening the desktop app.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-backdrop" />
      <main className="app-frame">
        <header className={`topbar${appView === 'onboarding' ? ' topbar-compact' : ''}`}>
          <div className="topbar-copy">
            <div className="app-badge">key-b0x</div>
          </div>

          {appView === 'dashboard' ? (
            <div className="topbar-actions">
              <button
                type="button"
                className={`icon-button${settingsOpen ? ' icon-button-active' : ''}`}
                aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
                onClick={() => {
                  void toggleSettings();
                }}
              >
                <span className="icon-button-sliders" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </button>
            </div>
          ) : null}
        </header>

        {appView === 'onboarding' ? (
          <section className="wizard-shell">
            {screenError ? <div className="banner banner-error">{screenError}</div> : null}

            <div className="wizard-intro">
              <div className="wizard-intro-copy">
                <div className="section-eyebrow">{onboardingStepLabel(onboardingStep)}</div>
                <h2>{onboardingStepTitle(onboardingStep)}</h2>
              </div>
            </div>

            {onboardingStep === 'path' ? (
              <SetupSection
                busyAction={busyAction}
                slippiPathDraft={slippiPathDraft}
                setSlippiPathDraft={setSlippiPathDraft}
                label="Path"
                onBrowsePath={handleBrowseSlippiPath}
              />
            ) : onboardingStep === 'profile' ? (
              <div className="settings-card settings-card-setup">
                <div className="settings-card-copy">
                  <h3 className="settings-card-title">Dolphin / Ishiiruka Setup</h3>
                  <p className="settings-card-description">
                    Finish the controller setup in Dolphin or Ishiiruka before starting the runtime.
                  </p>
                </div>
                <ol className="wizard-step-list">
                  <li>Press the Controller button in Dolphin or Ishiiruka.</li>
                  <li>Set Port 1 to Standard Controller.</li>
                  <li>Select the key-b0x profile and press Load.</li>
                </ol>
                <p className="wizard-step-note">When that is done, press Next.</p>
              </div>
            ) : (
              <KeyboardTestLauncherCard
                context="onboarding"
                busy={keyboardTestBusy}
                onOpen={() => {
                  void openKeyboardTest('onboarding');
                }}
              />
            )}

            <footer className="wizard-footer">
              <div className="wizard-actions">
                {onboardingStep !== 'path' ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busyAction === 'complete-onboarding' || keyboardTestBusy}
                    onClick={() => {
                      void goToPreviousStep();
                    }}
                  >
                    Back
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button-primary"
                  disabled={
                    runtimeLocked ||
                    busyAction === 'apply-setup' ||
                    busyAction === 'complete-onboarding' ||
                    keyboardTestBusy ||
                    (onboardingStep === 'keyboard' && keyboardTestOpen) ||
                    (onboardingStep === 'path' && slippiPathDraft.trim().length === 0)
                  }
                  onClick={goToNextStep}
                >
                  Next
                </button>
              </div>
            </footer>
          </section>
        ) : (
          <section className="dashboard-shell">
            {screenError ? <div className="banner banner-error">{screenError}</div> : null}
            {updateAvailable || updateReady ? (
              <UpdateBanner
                updateState={updateState}
                busyAction={busyAction}
                onDownload={() => {
                  void handleDownloadUpdate();
                }}
                onInstall={() => {
                  void handleInstallUpdate();
                }}
              />
            ) : null}
            {dashboardNotice ? <div className={`banner banner-${dashboardNotice.tone}`}>{dashboardNotice.message}</div> : null}

            <BindingsSection
              status={runtime.status}
              runtimeLocked={bindingsLocked}
              busyAction={busyAction}
              bindingDraft={bindingDraft}
              duplicateGroups={duplicateGroups}
              duplicateBindings={duplicateBindings}
              captureTarget={captureTarget}
              bindingsDirty={bindingsDirty}
              keyLabel={keyLabel}
              onRestoreDefaults={handleRestoreDefaults}
              onSaveBindings={handleSaveBindings}
              onSelectBinding={(binding) => {
                setCaptureTarget(binding);
              }}
            />
          </section>
        )}
      </main>

      {appView === 'dashboard' && settingsOpen ? (
        <div
          className="settings-shell"
          role="presentation"
          onClick={() => {
            void closeSettings();
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-copy">
                <div className="section-eyebrow">Runtime Config</div>
                <h2 id="settings-title" className="settings-modal-title">
                  Settings
                </h2>
                <p className="settings-modal-blurb">
                  Tweak runtime behavior and setup without touching unsaved binding edits.
                </p>
              </div>
              <button
                type="button"
                className="settings-close"
                aria-label="Close settings"
                onClick={() => {
                  void closeSettings();
                }}
              >
                Close
              </button>
            </div>

            <div className="settings-section">
              <div className="section-eyebrow">Setup</div>
              <SetupSection
                busyAction={busyAction}
                slippiPathDraft={slippiPathDraft}
                setSlippiPathDraft={setSlippiPathDraft}
                label="Slippi Path"
                onBrowsePath={handleBrowseSlippiPath}
                onApplySetup={setupDirty || !setupComplete ? handleApplySetup : undefined}
              />
              <ProfileResetCard
                busy={busyAction === 'reinstall-profile' || busyAction === 'apply-setup'}
                slippiReady={Boolean(setup?.slippiFound)}
                onReset={handleReinstallProfile}
              />
            </div>

            <div className="settings-section">
              <div className="section-eyebrow">Controls</div>
              <MeleeSettingsSection
                meleeDraft={meleeDraft}
                meleeDirty={meleeDirty}
                validationMessage={meleeValidationMessage}
                disabled={meleeLocked}
                onChange={setMeleeDraft}
                onRestoreDefaults={handleRestoreDefaultMelee}
                onSave={handleSaveMelee}
              />
            </div>

            <div className="settings-section">
              <div className="section-eyebrow">Keyboard</div>
              <KeyboardTestLauncherCard
                context="settings"
                busy={keyboardTestBusy}
                onOpen={() => {
                  void openKeyboardTest('settings');
                }}
              />
            </div>

            <div className="settings-section">
              <div className="section-eyebrow">Updates</div>
              <UpdatesSection
                updateState={updateState}
                busyAction={busyAction}
                onCheck={() => {
                  void handleCheckForUpdates();
                }}
                onDownload={() => {
                  void handleDownloadUpdate();
                }}
                onInstall={() => {
                  void handleInstallUpdate();
                }}
              />
            </div>
          </section>
        </div>
      ) : null}

      {keyboardTestOpen ? (
        <KeyboardTestModal
          keyboardTest={keyboardTest}
          busy={keyboardTestBusy}
          keyLabel={keyLabel}
          onClose={() => {
            void closeKeyboardTest();
          }}
        />
      ) : null}

      <ToastViewport toasts={toasts} runtimeStatus={runtime.status} onDismiss={dismissToast} />
    </div>
  );
}

function ProfileResetCard({
  busy,
  slippiReady,
  onReset
}: {
  busy: boolean;
  slippiReady: boolean;
  onReset: () => Promise<void>;
}) {
  return (
    <div className="settings-card settings-card-setup">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">Controller Profile</h3>
        <p className="settings-card-description">
          Rewrites the key-b0x controller profile inside the Slippi config directory. Reset it when
          Slippi or another tool has overwritten or deleted the file.
        </p>
      </div>

      <div className="settings-actions">
        <div className="settings-inline-note">
          {slippiReady
            ? 'The reset profile is picked up the next time Slippi loads the controller.'
            : 'Set a valid Slippi user path first.'}
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || !slippiReady}
            onClick={() => {
              void onReset();
            }}
          >
            Reset Profile File
          </button>
        </div>
      </div>
    </div>
  );
}

function SetupSection({
  busyAction,
  slippiPathDraft,
  setSlippiPathDraft,
  label,
  onBrowsePath,
  onApplySetup
}: {
  busyAction: string | null;
  slippiPathDraft: string;
  setSlippiPathDraft: (value: string) => void;
  label: string;
  onBrowsePath: () => Promise<void>;
  onApplySetup?: () => Promise<boolean>;
}) {
  return (
    <div className="settings-card settings-card-setup">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">{label}</h3>
        <p className="settings-card-description">
          Choose the Slippi user directory used for profile installation and pipe transport.
        </p>
      </div>

      <label htmlFor="slippi-path" className="settings-input-stack">
        <span className="settings-input-label">Slippi User Path</span>
        <div className="settings-path-row">
          <input
            id="slippi-path"
            className="text-input settings-text-input"
            value={slippiPathDraft}
            disabled={busyAction === 'apply-setup'}
            onChange={(event) => setSlippiPathDraft(event.target.value)}
          />
          <button
            type="button"
            className="button button-secondary settings-browse-button"
            disabled={busyAction === 'apply-setup'}
            onClick={() => {
              void onBrowsePath();
            }}
          >
            Browse
          </button>
        </div>
      </label>

      {onApplySetup ? (
        <div className="settings-actions">
          <div className="settings-inline-note">
            Saving updates the installed controller profile and restarts the runtime if needed.
          </div>
          <div className="toolbar-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busyAction === 'apply-setup'}
              onClick={() => {
                void onApplySetup();
              }}
            >
              Save Setup
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NerfToggleCard({
  draft,
  disabled,
  onChange
}: {
  draft: MeleeSettingsDraft;
  disabled: boolean;
  onChange: (draft: MeleeSettingsDraft) => void;
}) {
  return (
    <section className="settings-card settings-card-subtle">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">Active Nerfs</h3>
        <p className="settings-card-description">
          Fine-tune which nerfs apply to control stick output. The c-stick is never travel-timed or
          fuzzed, matching the ruleset.
        </p>
      </div>

      <div className="settings-toggle-list">
        {NERF_TOGGLE_ROWS.map((row) => {
          const active = draft[row.field];

          return (
            <div className="settings-toggle-row" key={row.field}>
              <div className="settings-toggle-copy">
                <span className="settings-toggle-label">{row.label}</span>
                <span className="settings-toggle-detail">{row.detail}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-label={row.label}
                className={`settings-toggle${active ? ' settings-toggle-active' : ''}`}
                disabled={disabled}
                onClick={() => onChange({ ...draft, [row.field]: !active })}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MeleeSettingsSection({
  meleeDraft,
  meleeDirty,
  validationMessage,
  disabled,
  onChange,
  onRestoreDefaults,
  onSave
}: {
  meleeDraft: MeleeSettingsDraft;
  meleeDirty: boolean;
  validationMessage: string | null;
  disabled: boolean;
  onChange: (draft: MeleeSettingsDraft) => void;
  onRestoreDefaults: () => void;
  onSave: () => Promise<void>;
}) {
  return (
    <div className="settings-stack">
      <SettingChoiceGroup
        label="SOCD Mode"
        description="Controls overlapping opposite directions. Neutral (the default) cancels them out; 2IP No Reactivation matches B0XX Melee behavior, and reactivation suits keyboard-like holds."
        value={meleeDraft.socd_mode}
        options={SOCD_MODE_OPTIONS}
        disabled={disabled}
        columns="wide"
        onChange={(value) => onChange({ ...meleeDraft, socd_mode: value })}
      />

      <SettingChoiceGroup
        label="Rectangle Nerfs"
        description="Applies the rectangle controller nerfs from the Melee controller ruleset proposal. Set SOCD Mode to Neutral for full ruleset compliance."
        value={meleeDraft.nerfs_enabled ? 'enabled' : 'disabled'}
        options={NERF_MASTER_OPTIONS}
        disabled={disabled}
        columns="compact"
        onChange={(value) => onChange({ ...meleeDraft, nerfs_enabled: value === 'enabled' })}
      />

      {meleeDraft.nerfs_enabled ? (
        <NerfToggleCard draft={meleeDraft} disabled={disabled} onChange={onChange} />
      ) : null}

      <SettingChoiceGroup
        label="Down Diagonal"
        description="Choose between auto jab cancel behavior and crouch walk OS."
        value={meleeDraft.down_diagonal}
        options={DOWN_DIAGONAL_OPTIONS}
        disabled={disabled}
        columns="compact"
        onChange={(value) => onChange({ ...meleeDraft, down_diagonal: value })}
      />

      <SettingChoiceGroup
        label="Horizontal SOCD Override"
        description="Keep the jump-friendly horizontal override or disable it outright."
        value={meleeDraft.horizontal_socd_override}
        options={HORIZONTAL_SOCD_OVERRIDE_OPTIONS}
        disabled={disabled}
        columns="compact"
        onChange={(value) =>
          onChange({
            ...meleeDraft,
            horizontal_socd_override: value
          })
        }
      />

      <SettingChoiceGroup
        label="Airdodge"
        description="Use the default runtime diagonal or tune a custom Mod-X shield diagonal."
        value={meleeDraft.airdodge_kind}
        options={AIRDODGE_KIND_OPTIONS}
        disabled={disabled}
        columns="compact"
        onChange={(value) => onChange({ ...meleeDraft, airdodge_kind: value })}
      />

      {meleeDraft.airdodge_kind === 'custom_mod_x_diagonal' ? (
        <AirdodgeAxisCard
          x={meleeDraft.airdodge_x}
          y={meleeDraft.airdodge_y}
          disabled={disabled}
          onChangeX={(value) => onChange({ ...meleeDraft, airdodge_x: value })}
          onChangeY={(value) => onChange({ ...meleeDraft, airdodge_y: value })}
        />
      ) : null}

      {validationMessage ? <div className="banner banner-warning">{validationMessage}</div> : null}
      {meleeDirty ? <div className="settings-inline-note">Unsaved melee settings.</div> : null}

      <div className="settings-actions settings-actions-elevated">
        <div className="settings-inline-note">Saving restarts the runtime.</div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled}
            onClick={onRestoreDefaults}
          >
            Restore Defaults
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={disabled || !meleeDirty || Boolean(validationMessage)}
            onClick={() => {
              void onSave();
            }}
          >
            Save Melee Settings
          </button>
        </div>
      </div>
    </div>
  );
}

function UpdatesSection({
  updateState,
  busyAction,
  onCheck,
  onDownload,
  onInstall
}: {
  updateState: UpdateState;
  busyAction: string | null;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const checking = busyAction === 'check-for-update' || updateState.status === 'checking';
  const downloading = busyAction === 'download-update' || updateState.status === 'downloading';
  const installing = busyAction === 'install-update' || updateState.status === 'installing';
  const available = canDownloadUpdate(updateState);
  const ready = canInstallUpdate(updateState);
  const progressText = formatUpdateProgress(updateState);
  const installLabel = isWindows() ? 'Install Update' : 'Restart to Update';

  return (
    <div className="settings-card settings-card-setup">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">Updates</h3>
        <p className="settings-card-description">
          Check for new releases without leaving the app, then choose when to download and apply
          them.
        </p>
      </div>

      <div className="settings-meta-grid">
        <div className="settings-meta-item">
          <span className="settings-meta-label">Current Version</span>
          <strong className="settings-meta-value">{updateState.currentVersion || 'Unknown'}</strong>
        </div>
        <div className="settings-meta-item">
          <span className="settings-meta-label">Latest Version</span>
          <strong className="settings-meta-value">{updateState.latestVersion ?? 'Not checked yet'}</strong>
        </div>
        <div className="settings-meta-item">
          <span className="settings-meta-label">Status</span>
          <strong className="settings-meta-value">{updateStatusLabel(updateState.status)}</strong>
        </div>
        {progressText ? (
          <div className="settings-meta-item">
            <span className="settings-meta-label">Progress</span>
            <strong className="settings-meta-value">{progressText}</strong>
          </div>
        ) : null}
      </div>

      {updateState.notes ? (
        <div className="settings-card settings-card-subtle settings-card-embedded">
          <div className="settings-card-copy">
            <h4 className="settings-card-title">Release Notes</h4>
            <p className="settings-card-description">{updateState.notes}</p>
          </div>
        </div>
      ) : null}

      {updateState.lastError ? <div className="banner banner-error">{updateState.lastError}</div> : null}

      <div className="settings-actions settings-actions-elevated">
        <div className="settings-inline-note">
          {isWindows()
            ? 'Installing an update closes key-b0x briefly while the installer runs.'
            : 'For in-app updates, keep key-b0x.AppImage in a writable location such as ~/Applications/key-b0x.AppImage.'}
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={checking || downloading || installing || ready}
            onClick={onCheck}
          >
            Check for Updates
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={!available || checking || downloading || installing}
            onClick={onDownload}
          >
            {downloading ? 'Downloading…' : 'Download Update'}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!ready || checking || downloading || installing}
            onClick={onInstall}
          >
            {installing ? 'Installing…' : installLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function UpdateBanner({
  updateState,
  busyAction,
  onDownload,
  onInstall
}: {
  updateState: UpdateState;
  busyAction: string | null;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const ready = canInstallUpdate(updateState);
  const available = canDownloadUpdate(updateState);
  const actionLabel = ready ? (isWindows() ? 'Install Update' : 'Restart to Update') : 'Download Update';

  return (
    <div className="banner banner-info banner-action">
      <span>
        {ready
          ? `Update ${updateState.latestVersion ?? ''} is ready to apply.`
          : `Update ${updateState.latestVersion ?? ''} is available.`}
      </span>
      <button
        type="button"
        className="button button-secondary"
        disabled={
          busyAction === 'check-for-update' ||
          busyAction === 'download-update' ||
          busyAction === 'install-update'
        }
        onClick={ready ? onInstall : available ? onDownload : undefined}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function KeyboardTestLauncherCard({
  context,
  busy,
  onOpen
}: {
  context: KeyboardTestSource;
  busy: boolean;
  onOpen: () => void;
}) {
  const description =
    context === 'onboarding'
      ? 'Open the keyboard test and hold the combinations you plan to use. A good keyboard should show every held key at the same time.'
      : 'Check whether your keyboard can hold the combinations key-b0x needs before you play.';

  const note =
    context === 'onboarding'
      ? 'If a held key never appears with the others, that keyboard is likely not suitable.'
      : 'The runtime pauses while the test is open, and resumes when the test closes or key-b0x loses focus.';

  return (
    <div className="settings-card settings-card-setup">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">Keyboard Test</h3>
        <p className="settings-card-description">{description}</p>
      </div>

      <div className="settings-actions">
        <div className="settings-inline-note">{note}</div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={onOpen}
          >
            Open Keyboard Test
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyboardTestModal({
  keyboardTest,
  busy,
  keyLabel,
  onClose
}: {
  keyboardTest: KeyboardTestState;
  busy: boolean;
  keyLabel: (key: NormalizedKey) => string;
  onClose: () => void;
}) {
  return (
    <div
      className="settings-shell keyboard-test-shell"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="settings-modal keyboard-test-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-test-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-copy">
            <div className="section-eyebrow">Input Check</div>
            <h2 id="keyboard-test-title" className="settings-modal-title">
              Keyboard Test
            </h2>
            <p className="settings-modal-blurb">
              Hold the combinations you plan to use. If your keyboard works well, every key you are
              holding should appear here at the same time.
            </p>
          </div>
          <button
            type="button"
            className="settings-close"
            aria-label="Close keyboard test"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-card settings-card-subtle">
            <div className="settings-card-copy">
              <h3 className="settings-card-title">What to Expect</h3>
              <p className="settings-card-description">
                Most gaming and mechanical keyboards should show every held key together. Many
                laptop and non-gaming keyboards will miss some combinations.
              </p>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-copy">
              <h3 className="settings-card-title">Detected Keys</h3>
              <p className="settings-card-description">
                Press and hold several keys. If one never appears or drops out while held with the
                others, the keyboard is not a good fit for key-b0x.
              </p>
            </div>

            {keyboardTest.status === 'error' ? (
              <div className="banner banner-error">
                {keyboardTest.lastError ?? 'Keyboard test failed to start.'}
              </div>
            ) : keyboardTest.pressedKeys.length > 0 ? (
              <div className="keyboard-test-key-grid">
                {keyboardTest.pressedKeys.map((key) => (
                  <div key={key} className="keyboard-test-key">
                    {keyLabel(key)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="keyboard-test-empty">
                Hold a few keys now. Every key you are holding should appear here.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingChoiceGroup<T extends string>({
  label,
  description,
  value,
  options,
  disabled,
  columns,
  onChange
}: {
  label: string;
  description: string;
  value: T;
  options: SelectOption<T>[];
  disabled: boolean;
  columns: 'compact' | 'wide';
  onChange: (value: T) => void;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">{label}</h3>
        <p className="settings-card-description">{description}</p>
      </div>

      <div
        className={`settings-choice-grid settings-choice-grid-${columns}`}
        role="group"
        aria-label={label}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`settings-choice${option.value === value ? ' settings-choice-active' : ''}`}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            <span className="settings-choice-head">
              <span className="settings-choice-label">{option.label}</span>
              {option.tag ? <span className="settings-choice-tag">{option.tag}</span> : null}
            </span>
            {option.detail ? <span className="settings-choice-detail">{option.detail}</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function AirdodgeAxisCard({
  x,
  y,
  disabled,
  onChangeX,
  onChangeY
}: {
  x: string;
  y: string;
  disabled: boolean;
  onChangeX: (value: string) => void;
  onChangeY: (value: string) => void;
}) {
  return (
    <section className="settings-card settings-card-subtle">
      <div className="settings-card-copy">
        <h3 className="settings-card-title">Custom Airdodge Diagonal</h3>
        <p className="settings-card-description">
          Set precise X and Y values between 0 and 1. Step size: 0.0125.
        </p>
      </div>

      <div className="settings-axis-grid">
        <label className="settings-axis-field">
          <span className="settings-axis-label">Custom Airdodge X</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="1"
            step="0.0125"
            className="text-input settings-text-input"
            value={x}
            disabled={disabled}
            onChange={(event) => onChangeX(event.target.value)}
          />
        </label>

        <label className="settings-axis-field">
          <span className="settings-axis-label">Custom Airdodge Y</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="1"
            step="0.0125"
            className="text-input settings-text-input"
            value={y}
            disabled={disabled}
            onChange={(event) => onChangeY(event.target.value)}
          />
        </label>
      </div>
    </section>
  );
}

function BindingsSection({
  status,
  runtimeLocked,
  busyAction,
  bindingDraft,
  duplicateGroups,
  duplicateBindings,
  captureTarget,
  bindingsDirty,
  keyLabel,
  onRestoreDefaults,
  onSaveBindings,
  onSelectBinding
}: {
  status: RuntimeState['status'];
  runtimeLocked: boolean;
  busyAction: string | null;
  bindingDraft: BindingMap;
  duplicateGroups: Array<{ key: NormalizedKey; bindings: BindingId[] }>;
  duplicateBindings: Set<BindingId>;
  captureTarget: BindingId | null;
  bindingsDirty: boolean;
  keyLabel: (key: NormalizedKey) => string;
  onRestoreDefaults: () => void;
  onSaveBindings: () => Promise<void>;
  onSelectBinding: (binding: BindingId) => void;
}) {
  return (
    <div className="editor-shell">
      <div className="editor-toolbar">
        <div className="toolbar-status">
          <StatusFlag status={status} />
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={runtimeLocked}
            onClick={onRestoreDefaults}
          >
            Restore Defaults
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={
              runtimeLocked ||
              busyAction === 'save-bindings' ||
              duplicateGroups.length > 0 ||
              !bindingsDirty
            }
            onClick={() => {
              void onSaveBindings();
            }}
          >
            Save Bindings
          </button>
        </div>
      </div>

      {duplicateGroups.length > 0 ? (
        <div className="banner banner-warning">{duplicateMessage(duplicateGroups[0], keyLabel)}</div>
      ) : captureTarget ? (
        <div className="banner banner-info">Press a key. Esc cancels.</div>
      ) : bindingsDirty ? (
        <div className="binding-note">Unsaved binding changes.</div>
      ) : null}

      <div className="binding-groups">
        {BINDING_GROUPS.map((group) => (
          <section key={group.id} className="binding-group">
            <div className="binding-group-header">
              <h3>{group.title}</h3>
              <p>{group.description}</p>
            </div>
            <div className="binding-table">
              {group.bindings.map((binding) => {
                const key = bindingDraft[binding];
                const isCapturing = captureTarget === binding;
                const hasConflict = duplicateBindings.has(binding);

                return (
                  <button
                    key={binding}
                    type="button"
                    className={`binding-row${isCapturing ? ' binding-row-capturing' : ''}${
                      hasConflict ? ' binding-row-conflict' : ''
                    }`}
                    disabled={runtimeLocked}
                    onClick={() => onSelectBinding(binding)}
                  >
                    <span className="binding-row-label">{formatBindingLabel(binding)}</span>
                    <span className="binding-row-key">
                      {isCapturing ? 'Press key' : keyLabel(key)}
                    </span>
                    <span className="binding-row-state">
                      {hasConflict ? 'Conflict' : 'Edit'}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ToastViewport({
  toasts,
  runtimeStatus,
  onDismiss
}: {
  toasts: Toast[];
  runtimeStatus: RuntimeState['status'];
  onDismiss: (id: number) => void;
}) {
  const waitingToast =
    runtimeStatus === 'waiting_for_slippi'
      ? {
          id: WAITING_FOR_SLIPPI_TOAST_ID,
          message:
            'In Slippi/Dolphin, set Port 1 to Standard Controller and load the key-b0x profile. Then restart Slippi if it still does not connect.',
          tone: 'warning' as const,
          persistent: true
        }
      : null;

  const allToasts = waitingToast ? [waitingToast, ...toasts] : toasts;

  if (allToasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {allToasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}${'persistent' in toast && toast.persistent ? ' toast-persistent' : ''}`}
        >
          <div className="toast-message">{toast.message}</div>
          {'persistent' in toast && toast.persistent ? null : (
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
            >
              x
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusFlag({
  status,
  large = false
}: {
  status: RuntimeState['status'];
  large?: boolean;
}) {
  return (
    <div className={`status-flag status-flag-${status}${large ? ' status-flag-large' : ''}`}>
      {statusLabel(status)}
    </div>
  );
}

function statusLabel(status: RuntimeState['status']): string {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'waiting_for_slippi':
      return 'Waiting for Slippi';
    case 'stopping':
      return 'Stopping';
    case 'error':
      return 'Error';
  }
}

function duplicateMessage(
  conflict: { key: NormalizedKey; bindings: BindingId[] },
  keyLabel: (key: NormalizedKey) => string = formatKeyLabel
): string {
  const bindingNames = conflict.bindings.map((binding) => formatBindingLabel(binding)).join(' and ');
  return `${keyLabel(conflict.key)} is assigned to ${bindingNames}.`;
}

function getInitialRoute(config: AppConfig, setup: SetupStatus): AppView {
  const setupComplete = setup.slippiFound && setup.profileInstalled;

  return setupComplete && config.onboarding_completed ? 'dashboard' : 'onboarding';
}

function getInitialOnboardingStep(config: AppConfig, setup: SetupStatus): OnboardingStep {
  const setupComplete = setup.slippiFound && setup.profileInstalled;

  if (!setupComplete) {
    return 'path';
  }

  return config.onboarding_completed ? 'path' : 'profile';
}

function onboardingStepLabel(step: OnboardingStep): string {
  switch (step) {
    case 'path':
      return 'Step 1 of 3';
    case 'profile':
      return 'Step 2 of 3';
    case 'keyboard':
      return 'Step 3 of 3';
  }
}

function onboardingStepTitle(step: OnboardingStep): string {
  switch (step) {
    case 'path':
      return 'Detected Slippi Path';
    case 'profile':
      return 'Load Controller Profile';
    case 'keyboard':
      return 'Keyboard Test';
  }
}

function updateStatusLabel(status: UpdateState['status']): string {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'checking':
      return 'Checking';
    case 'available':
      return 'Update available';
    case 'downloading':
      return 'Downloading';
    case 'downloaded':
      return 'Ready to install';
    case 'installing':
      return 'Installing';
    case 'up_to_date':
      return 'Up to date';
    case 'error':
      return 'Error';
  }
}

function canDownloadUpdate(updateState: UpdateState): boolean {
  return (
    updateState.status === 'available' ||
    (updateState.status === 'error' &&
      Boolean(updateState.latestVersion) &&
      !Boolean(updateState.downloadedBytes))
  );
}

function canInstallUpdate(updateState: UpdateState): boolean {
  return (
    updateState.status === 'downloaded' ||
    (updateState.status === 'error' && Boolean(updateState.downloadedBytes))
  );
}

function formatUpdateProgress(updateState: UpdateState): string | null {
  if (
    (updateState.status !== 'downloading' && updateState.status !== 'downloaded') ||
    updateState.downloadedBytes == null
  ) {
    return null;
  }

  if (updateState.contentLength == null || updateState.contentLength === 0) {
    return formatByteSize(updateState.downloadedBytes);
  }

  const percent = Math.min(
    100,
    Math.round((updateState.downloadedBytes / updateState.contentLength) * 100)
  );

  return `${percent}% (${formatByteSize(updateState.downloadedBytes)} / ${formatByteSize(
    updateState.contentLength
  )})`;
}

function getDashboardNotice({
  setupComplete,
  duplicateGroups,
  keyLabel
}: {
  setupComplete: boolean;
  duplicateGroups: Array<{ key: NormalizedKey; bindings: BindingId[] }>;
  keyLabel: (key: NormalizedKey) => string;
}): { tone: 'warning' | 'info'; message: string } | null {
  if (!setupComplete) {
    return {
      tone: 'warning',
      message: 'Setup is incomplete. Open Settings to finish it.'
    };
  }

  if (duplicateGroups.length > 0) {
    return {
      tone: 'warning',
      message: duplicateMessage(duplicateGroups[0], keyLabel)
    };
  }

  return null;
}

function isRuntimeLocked(status: RuntimeState['status']): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_for_slippi' ||
    status === 'stopping'
  );
}

function isRuntimeLive(status: RuntimeState['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting_for_slippi';
}

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function meleeDraftFromConfig(melee: MeleeConfig): MeleeSettingsDraft {
  return {
    socd_mode: melee.socd.main_x,
    down_diagonal: melee.down_diagonal,
    horizontal_socd_override: melee.horizontal_socd_override,
    airdodge_kind: melee.airdodge.kind,
    airdodge_x:
      melee.airdodge.kind === 'custom_mod_x_diagonal' ? formatDraftNumber(melee.airdodge.x) : '',
    airdodge_y:
      melee.airdodge.kind === 'custom_mod_x_diagonal' ? formatDraftNumber(melee.airdodge.y) : '',
    nerfs_enabled: melee.nerfs.enabled,
    nerfs_travel_time: melee.nerfs.travel_time,
    nerfs_fuzzing: melee.nerfs.fuzzing,
    nerfs_coordinate_limits: melee.nerfs.coordinate_limits,
    nerfs_timing_lockouts: melee.nerfs.timing_lockouts
  };
}

function nerfConfigFromDraft(draft: MeleeSettingsDraft): MeleeConfig['nerfs'] {
  return {
    enabled: draft.nerfs_enabled,
    travel_time: draft.nerfs_travel_time,
    fuzzing: draft.nerfs_fuzzing,
    coordinate_limits: draft.nerfs_coordinate_limits,
    timing_lockouts: draft.nerfs_timing_lockouts
  };
}

function meleeConfigFromDraft(draft: MeleeSettingsDraft): MeleeConfig {
  if (draft.airdodge_kind === 'custom_mod_x_diagonal') {
    return {
      socd: createUniformSocdConfig(draft.socd_mode),
      down_diagonal: draft.down_diagonal,
      horizontal_socd_override: draft.horizontal_socd_override,
      airdodge: {
        kind: 'custom_mod_x_diagonal',
        x: Number(draft.airdodge_x.trim()),
        y: Number(draft.airdodge_y.trim())
      },
      nerfs: nerfConfigFromDraft(draft)
    };
  }

  return {
    socd: createUniformSocdConfig(draft.socd_mode),
    down_diagonal: draft.down_diagonal,
    horizontal_socd_override: draft.horizontal_socd_override,
    airdodge: {
      kind: 'default'
    },
    nerfs: nerfConfigFromDraft(draft)
  };
}

function validateMeleeDraft(draft: MeleeSettingsDraft): string | null {
  if (draft.airdodge_kind !== 'custom_mod_x_diagonal') {
    return null;
  }

  const xText = draft.airdodge_x.trim();
  const yText = draft.airdodge_y.trim();

  if (xText.length === 0 || yText.length === 0) {
    return 'Custom airdodge X and Y are required.';
  }

  const x = Number(xText);
  const y = Number(yText);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return 'Custom airdodge X and Y must be numeric.';
  }

  if (x <= 0 || x > 1 || y <= 0 || y > 1) {
    return 'Custom airdodge X and Y must be within (0, 1].';
  }

  return null;
}

function meleeDraftMatchesConfig(draft: MeleeSettingsDraft, melee: MeleeConfig): boolean {
  if (
    draft.socd_mode !== melee.socd.main_x ||
    draft.socd_mode !== melee.socd.main_y ||
    draft.socd_mode !== melee.socd.c_x ||
    draft.socd_mode !== melee.socd.c_y ||
    draft.down_diagonal !== melee.down_diagonal ||
    draft.horizontal_socd_override !== melee.horizontal_socd_override ||
    draft.airdodge_kind !== melee.airdodge.kind ||
    draft.nerfs_enabled !== melee.nerfs.enabled ||
    draft.nerfs_travel_time !== melee.nerfs.travel_time ||
    draft.nerfs_fuzzing !== melee.nerfs.fuzzing ||
    draft.nerfs_coordinate_limits !== melee.nerfs.coordinate_limits ||
    draft.nerfs_timing_lockouts !== melee.nerfs.timing_lockouts
  ) {
    return false;
  }

  if (draft.airdodge_kind !== 'custom_mod_x_diagonal') {
    return true;
  }

  const validationMessage = validateMeleeDraft(draft);
  if (validationMessage) {
    return false;
  }

  return (
    melee.airdodge.kind === 'custom_mod_x_diagonal' &&
    Number(draft.airdodge_x.trim()) === melee.airdodge.x &&
    Number(draft.airdodge_y.trim()) === melee.airdodge.y
  );
}

function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    bindings: { ...config.bindings },
    melee: cloneMeleeConfig(config.melee)
  };
}

function bindingMapsEqual(left: BindingMap, right: BindingMap): boolean {
  return Object.keys(left).every(
    (binding) => left[binding as BindingId] === right[binding as BindingId]
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong.';
}

function createUniformSocdConfig(mode: SocdMode): MeleeConfig['socd'] {
  return {
    main_x: mode,
    main_y: mode,
    c_x: mode,
    c_y: mode
  };
}

function formatDraftNumber(value: number): string {
  return `${value}`;
}

export default App;
