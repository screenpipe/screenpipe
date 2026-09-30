// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use audiopipe::ParakeetExecutionProvider;

#[derive(Debug, Clone, PartialEq, Eq)]
struct AdapterCandidate {
    ordinal: u32,
    name: String,
    dedicated_video_memory: u64,
    software: bool,
    remote: bool,
    d3d12_compatible: Result<(), String>,
    unified_memory_architecture: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParakeetProviderChoice {
    pub provider: ParakeetExecutionProvider,
    pub reason: String,
}

fn choose_from_candidates(
    override_value: Option<&str>,
    candidates: Result<Vec<AdapterCandidate>, String>,
) -> ParakeetProviderChoice {
    if override_value.is_some_and(|value| value == "0" || value.eq_ignore_ascii_case("false")) {
        return ParakeetProviderChoice {
            provider: ParakeetExecutionProvider::Cpu,
            reason: "SCREENPIPE_DIRECTML explicitly disabled".to_string(),
        };
    }
    let candidates = match candidates {
        Ok(candidates) => candidates,
        Err(error) => {
            return ParakeetProviderChoice {
                provider: ParakeetExecutionProvider::Cpu,
                reason: format!("DXGI adapter enumeration failed; using CPU: {error}"),
            };
        }
    };
    let capability_errors = candidates
        .iter()
        .filter_map(|adapter| adapter.d3d12_compatible.as_ref().err())
        .cloned()
        .collect::<Vec<_>>();
    let eligible = candidates
        .into_iter()
        .filter(|adapter| !adapter.software && !adapter.remote)
        .filter(|adapter| adapter.d3d12_compatible.is_ok())
        .max_by_key(|adapter| adapter.dedicated_video_memory);

    match eligible {
        Some(adapter) => ParakeetProviderChoice {
            provider: ParakeetExecutionProvider::DirectMlDevice(adapter.ordinal as i32),
            reason: format!(
                "compatible hardware adapter ordinal {} ('{}') with {} MiB dedicated video memory, UMA={}",
                adapter.ordinal,
                adapter.name,
                adapter.dedicated_video_memory / (1024 * 1024),
                adapter.unified_memory_architecture.map_or("unknown".to_string(), |uma| uma.to_string())
            ),
        },
        None => ParakeetProviderChoice {
            provider: ParakeetExecutionProvider::Cpu,
            reason: format!(
                "no non-software, non-remote, D3D12-compatible hardware adapter{}",
                if capability_errors.is_empty() {
                    String::new()
                } else {
                    format!("; capability checks failed: {}", capability_errors.join(" | "))
                }
            ),
        },
    }
}

pub(crate) fn choose_parakeet_provider() -> ParakeetProviderChoice {
    let override_value = std::env::var("SCREENPIPE_DIRECTML").ok();
    if override_value
        .as_deref()
        .is_some_and(|value| value == "0" || value.eq_ignore_ascii_case("false"))
    {
        return choose_from_candidates(override_value.as_deref(), Ok(Vec::new()));
    }
    choose_from_candidates(
        override_value.as_deref(),
        enumerate_adapters().map_err(|error| format!("HRESULT {:#010x}: {error}", error.code().0)),
    )
}

fn enumerate_adapters() -> windows::core::Result<Vec<AdapterCandidate>> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_REMOTE, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_ERROR_NOT_FOUND,
    };

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut adapters = Vec::new();
    for index in 0.. {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error),
        };
        let desc = unsafe { adapter.GetDesc1()? };
        let name_len = desc
            .Description
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(desc.Description.len());
        let name = String::from_utf16_lossy(&desc.Description[..name_len]);
        let capabilities = adapter_capabilities(&adapter);
        adapters.push(AdapterCandidate {
            ordinal: index,
            name: name.clone(),
            dedicated_video_memory: desc.DedicatedVideoMemory as u64,
            software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
            remote: desc.Flags & DXGI_ADAPTER_FLAG_REMOTE.0 as u32 != 0,
            d3d12_compatible: capabilities.as_ref().map(|_| ()).map_err(|error| {
                format!(
                    "adapter ordinal {index} ('{name}') D3D12CreateDevice failed with HRESULT {:#010x}: {error}",
                    error.code().0
                )
            }),
            unified_memory_architecture: capabilities.ok().flatten(),
        });
    }
    Ok(adapters)
}

fn adapter_capabilities(
    adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1,
) -> windows::core::Result<Option<bool>> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
    use windows::Win32::Graphics::Direct3D12::{
        D3D12CreateDevice, ID3D12Device, D3D12_FEATURE_ARCHITECTURE1,
        D3D12_FEATURE_DATA_ARCHITECTURE1,
    };

    let mut device = None;
    unsafe { D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, &mut device)? };
    let device: ID3D12Device = device.expect("D3D12CreateDevice succeeded without a device");
    let mut architecture = D3D12_FEATURE_DATA_ARCHITECTURE1::default();
    let architecture_result = unsafe {
        device.CheckFeatureSupport(
            D3D12_FEATURE_ARCHITECTURE1,
            (&mut architecture as *mut D3D12_FEATURE_DATA_ARCHITECTURE1).cast::<c_void>(),
            std::mem::size_of::<D3D12_FEATURE_DATA_ARCHITECTURE1>() as u32,
        )
    };
    Ok(architecture_result.ok().map(|_| architecture.UMA.as_bool()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(name: &str, gib: u64) -> AdapterCandidate {
        AdapterCandidate {
            ordinal: gib as u32,
            name: name.to_string(),
            dedicated_video_memory: gib * 1024 * 1024 * 1024,
            software: false,
            remote: false,
            d3d12_compatible: Ok(()),
            unified_memory_architecture: Some(false),
        }
    }

    #[test]
    fn automatically_selects_largest_eligible_hardware_adapter() {
        let choice =
            choose_from_candidates(None, Ok(vec![adapter("GPU 4", 4), adapter("GPU 8", 8)]));
        assert_eq!(
            choice.provider,
            ParakeetExecutionProvider::DirectMlDevice(8)
        );
        assert!(choice.reason.contains("GPU 8"));
    }

    #[test]
    fn explicit_cpu_override_wins_before_enumeration() {
        let choice = choose_from_candidates(Some("false"), Err("must not be observed".to_string()));
        assert_eq!(choice.provider, ParakeetExecutionProvider::Cpu);
        assert!(choice.reason.contains("explicitly disabled"));
        assert!(!choice.reason.contains("must not be observed"));
    }

    #[test]
    fn integrated_zero_and_low_dedicated_memory_adapters_are_eligible() {
        let mut software = adapter("software", 16);
        software.software = true;
        let mut remote = adapter("remote", 16);
        remote.remote = true;
        let mut integrated = adapter("integrated", 0);
        integrated.ordinal = 7;
        integrated.unified_memory_architecture = Some(true);
        let choice = choose_from_candidates(None, Ok(vec![integrated, software, remote]));
        assert_eq!(
            choice.provider,
            ParakeetExecutionProvider::DirectMlDevice(7)
        );
        assert!(choice.reason.contains("UMA=true"));
    }

    #[test]
    fn selected_dxgi_ordinal_is_the_directml_device_id() {
        let mut selected = adapter("selected", 8);
        selected.ordinal = 3;
        let choice = choose_from_candidates(None, Ok(vec![selected]));
        assert_eq!(
            choice.provider,
            ParakeetExecutionProvider::DirectMlDevice(3)
        );
    }

    #[test]
    fn enumeration_and_architecture_errors_are_support_visible_cpu_reasons() {
        let enumeration = choose_from_candidates(None, Err("0x887a0001 fixture".to_string()));
        assert_eq!(enumeration.provider, ParakeetExecutionProvider::Cpu);
        assert!(enumeration.reason.contains("0x887a0001"));

        let mut unknown = adapter("unknown", 8);
        unknown.d3d12_compatible = Err("D3D12CreateDevice HRESULT fixture".to_string());
        let capability = choose_from_candidates(None, Ok(vec![unknown]));
        assert_eq!(capability.provider, ParakeetExecutionProvider::Cpu);
        assert!(capability
            .reason
            .contains("D3D12CreateDevice HRESULT fixture"));
    }

    #[test]
    fn actual_adapter_selection_is_fresh_and_deterministic() {
        let first = choose_parakeet_provider();
        let second = choose_parakeet_provider();
        println!("actual Windows Parakeet provider choice: {first:?}");
        assert_eq!(first, second);
    }
}
