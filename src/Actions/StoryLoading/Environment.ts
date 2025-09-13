import Signal from "@rbxts/lemon-signal";
import { LoadVirtualModule } from "./Utils";
import { ScriptEditorService } from "@rbxts/services";

const HttpService = game.GetService("HttpService");

type Dependencies = Map<ModuleScript, { Result: unknown }>;
type DependencyLoaders = Map<ModuleScript, Promise<unknown>>;
type Listeners = Map<
	ModuleScript,
	{ connections: RBXScriptConnection[]; threads: thread[] }
>;

export class Environment {
	private _ActiveConnections = true;
	private _Dependencies: Dependencies = new Map();
	private _DependencyLoaders: DependencyLoaders = new Map();
	private _Listeners: Listeners = new Map();

	readonly EnvironmentUID: string;
	private _GlobalInjection?: Record<keyof any, unknown>;

	readonly Shared: {} = {};
	OnDependencyChanged = new Signal<[module: ModuleScript]>();
	private _DestroyedHooked?: () => void;

	constructor() {
		const uid = HttpService.GenerateGUID(false);
		this.EnvironmentUID = uid;
	}
	EnableGlobalInjection() {
		if (!this._GlobalInjection) {
			this._GlobalInjection = {};
		}
	}
	InjectGlobal(key: keyof any, value: unknown) {
		this.EnableGlobalInjection();
		this._GlobalInjection![key] = value;
	}
	GetGlobalInjection() {
		return this._GlobalInjection;
	}

	private _RegistryDependency(module: ModuleScript, result?: any) {
		this._Dependencies.set(module, { Result: result });
	}

	IsDependency(module: ModuleScript) {
		return this._Dependencies.has(module);
	}
	GetDependencyResult<T = unknown>(module: ModuleScript): T | undefined {
		return this._Dependencies.get(module)?.Result as T;
	}

	ListenDependency(module: ModuleScript) {
		if (!this._ActiveConnections) return;

		let lastSource = ScriptEditorService.GetEditorSource(module);

		const propertyListener = module
			.GetPropertyChangedSignal("Source")
			.Connect(() => {
				if (!this._ActiveConnections) return;

				const currentSource = module.Source;
				if (currentSource !== lastSource) {
					lastSource = currentSource;
					this.OnDependencyChanged.Fire(module);
				}
			});

		const checkThread = task.spawn(() => {
			while (task.wait(1) && this._ActiveConnections) {
				const currentSource = ScriptEditorService.GetEditorSource(module);
				if (currentSource !== lastSource) {
					lastSource = currentSource;
					this.OnDependencyChanged.Fire(module);
				}
			}
		});

		if (!this._Listeners.has(module)) {
			this._Listeners.set(module, { connections: [], threads: [] });
		}
		this._Listeners.get(module)!.connections.push(propertyListener);
		this._Listeners.get(module)!.threads.push(checkThread);
	}

	LoadDependency<T = unknown>(dependency: ModuleScript): Promise<T> {
		const cached = this.GetDependencyResult(dependency);
		if (cached !== undefined) {
			return Promise.resolve(cached as T);
		}
		const cachedLoader = this._DependencyLoaders.get(dependency) as Promise<T>;
		if (cachedLoader) {
			return cachedLoader.tap(() => {});
		}

		this.ListenDependency(dependency);

		const promise = LoadVirtualModule(dependency, this).tap((result) => {
			this._RegistryDependency(dependency, result);
		});
		this._DependencyLoaders.set(dependency, promise);

		return promise as Promise<T>;
	}

	HookOnDestroyed(callback: () => void) {
		this._DestroyedHooked = callback;
	}

	Destroy() {
		if (this._DestroyedHooked) {
			this._DestroyedHooked();
		}

		this._ActiveConnections = false;
		this._Listeners.forEach((module) => {
			module.connections.forEach((connection) => {
				connection.Disconnect();
			});
			module.threads.forEach(task.cancel);
		});
		this.OnDependencyChanged.Destroy();
	}
}
