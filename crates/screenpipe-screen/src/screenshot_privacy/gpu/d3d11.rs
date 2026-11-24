// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::D3dContext;
use crate::screenshot_privacy::{gpu, scene::Rect};
use anyhow::{ensure, Context, Result};
use image::{DynamicImage, RgbaImage};
use windows::{
    core::{s, PCSTR},
    Win32::Graphics::{
        Direct3D::{Fxc::D3DCompile, ID3DBlob},
        Direct3D11::*,
        Dxgi::Common::*,
    },
};

const SOURCE: &str = concat!(
    "Texture2D<float4> source : register(t0);\n",
    "StructuredBuffer<uint4> plan : register(t1);\n",
    "RWTexture2D<float4> output : register(u0);\n",
    "#define INPUTS uint unused\n",
    "#define SOURCE_TEXEL(x,y) source.Load(int3(x,y,0))\n",
    "#define MASK_INPUTS uint unused\n",
    "#define MASK_ARG 0\n",
    include_str!("triangle.inc"),
    r#"
[numthreads(8, 8, 1)]
void main(uint3 p : SV_DispatchThreadID) {
    if (any(p.xy >= plan[0].zw)) return;
    output[p.xy] = pixel(p.xy, 0);
}
"#,
);

pub(crate) struct Renderer {
    shader: ID3D11ComputeShader,
    outputs: [Option<Output>; 2],
}

struct Output {
    size: (u32, u32),
    texture: ID3D11Texture2D,
    uav: ID3D11UnorderedAccessView,
    staging: ID3D11Texture2D,
}

fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    unsafe { std::slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize()) }
}

impl Renderer {
    pub(super) fn new(device: &ID3D11Device) -> Result<Self> {
        let (mut code, mut diagnostics) = (None, None);
        unsafe {
            D3DCompile(
                SOURCE.as_ptr().cast(),
                SOURCE.len(),
                PCSTR::null(),
                None,
                None,
                s!("main"),
                s!("cs_5_0"),
                0,
                0,
                &mut code,
                Some(&mut diagnostics),
            )
        }
        .with_context(|| {
            format!(
                "compile D3D11 screenshot shader: {}",
                diagnostics
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(blob_bytes(b)))
                    .unwrap_or_default()
            )
        })?;
        let code = code.context("empty D3D11 screenshot shader")?;
        let mut shader = None;
        unsafe { device.CreateComputeShader(blob_bytes(&code), None, Some(&mut shader)) }?;
        Ok(Self {
            shader: shader.context("missing D3D11 screenshot shader")?,
            outputs: [None, None],
        })
    }

    pub(super) fn render(
        &mut self,
        d3d: &D3dContext,
        source: &ID3D11Texture2D,
        masks: Option<&[Rect]>,
        size: (u32, u32),
        slot: usize,
    ) -> Result<DynamicImage> {
        let dims = super::texture_dimensions(source);
        let params = gpu::plan(dims, size, masks, false);
        let stride = std::mem::size_of::<[u32; 4]>() as u32;
        let desc = D3D11_BUFFER_DESC {
            ByteWidth: u32::try_from(std::mem::size_of_val(params.as_slice()))?,
            Usage: D3D11_USAGE_IMMUTABLE,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_BUFFER_STRUCTURED.0 as u32,
            StructureByteStride: stride,
            ..Default::default()
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: params.as_ptr().cast(),
            ..Default::default()
        };
        let (mut buffer, mut plan, mut input) = (None, None, None);
        let plan_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
            Format: DXGI_FORMAT_UNKNOWN,
            ViewDimension: windows::Win32::Graphics::Direct3D::D3D_SRV_DIMENSION_BUFFER,
            Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                Buffer: D3D11_BUFFER_SRV {
                    Anonymous1: D3D11_BUFFER_SRV_0 { FirstElement: 0 },
                    Anonymous2: D3D11_BUFFER_SRV_1 {
                        NumElements: params.len() as u32,
                    },
                },
            },
        };
        unsafe {
            d3d.device
                .CreateBuffer(&desc, Some(&init), Some(&mut buffer))?;
            d3d.device.CreateShaderResourceView(
                buffer.as_ref().context("missing D3D11 mask buffer")?,
                Some(&plan_desc),
                Some(&mut plan),
            )?;
            d3d.device
                .CreateShaderResourceView(source, None, Some(&mut input))?;
        }
        if !self.outputs[slot].as_ref().is_some_and(|o| o.size == size) {
            self.outputs[slot] = Some(Output::new(&d3d.device, size)?);
        }
        let output = self.outputs[slot].as_ref().unwrap();
        let _guard = d3d.lock_context();
        let ctx = &d3d.context;
        unsafe {
            ctx.CSSetShader(&self.shader, None);
            ctx.CSSetShaderResources(0, Some(&[input, plan]));
            ctx.CSSetUnorderedAccessViews(0, 1, Some(&Some(output.uav.clone())), None);
            ctx.Dispatch(size.0.div_ceil(8), size.1.div_ceil(8), 1);
            ctx.CSSetUnorderedAccessViews(0, 1, Some(&None), None);
            ctx.CSSetShaderResources(0, Some(&[None, None]));
            ctx.CSSetShader(None, None);
            ctx.CopyResource(&output.staging, &output.texture);
            // Blocking Map includes shader execution and the staging transfer.
            read_mapped(ctx, &output.staging, size, false)
        }
    }
}

impl Output {
    fn new(device: &ID3D11Device, size: (u32, u32)) -> Result<Self> {
        let texture = create_texture(
            device,
            size,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            D3D11_USAGE_DEFAULT,
            D3D11_BIND_UNORDERED_ACCESS.0 as u32,
            0,
            None,
        )?;
        let staging = create_texture(
            device,
            size,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            D3D11_USAGE_STAGING,
            0,
            D3D11_CPU_ACCESS_READ.0 as u32,
            None,
        )?;
        let mut uav = None;
        unsafe { device.CreateUnorderedAccessView(&texture, None, Some(&mut uav)) }?;
        Ok(Self {
            size,
            texture,
            staging,
            uav: uav.context("missing D3D11 screenshot UAV")?,
        })
    }
}

pub(super) fn create_texture(
    device: &ID3D11Device,
    (width, height): (u32, u32),
    format: DXGI_FORMAT,
    usage: D3D11_USAGE,
    bind: u32,
    cpu_access: u32,
    data: Option<&[u8]>,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: usage,
        BindFlags: bind,
        CPUAccessFlags: cpu_access,
        MiscFlags: 0,
    };
    let init = data.map(|data| D3D11_SUBRESOURCE_DATA {
        pSysMem: data.as_ptr().cast(),
        SysMemPitch: width * 4,
        SysMemSlicePitch: 0,
    });
    let mut texture = None;
    unsafe {
        device.CreateTexture2D(
            &desc,
            init.as_ref().map(std::ptr::from_ref),
            Some(&mut texture),
        )
    }?;
    texture.context("missing D3D11 screenshot texture")
}

// Caller holds the D3D11 immediate context lock.
pub(super) unsafe fn read_mapped(
    ctx: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    size: (u32, u32),
    swizzle: bool,
) -> Result<DynamicImage> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
    let row_bytes = size.0 as usize * 4;
    let mut rgba = RgbaImage::new(size.0, size.1);
    let result = (|| {
        ensure!(
            !mapped.pData.is_null() && mapped.RowPitch as usize >= row_bytes,
            "invalid D3D11 screenshot readback"
        );
        for (y, row) in rgba.as_mut().chunks_exact_mut(row_bytes).enumerate() {
            let base = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
            row.copy_from_slice(std::slice::from_raw_parts(base, row_bytes));
        }
        Ok(())
    })();
    ctx.Unmap(staging, 0);
    result?;
    if swizzle {
        for pixel in rgba.as_mut().chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
    }
    Ok(DynamicImage::ImageRgba8(rgba))
}

#[cfg(feature = "screenshot-benchmark")]
pub(crate) struct Synthetic {
    d3d: std::sync::Arc<D3dContext>,
    renderer: Renderer,
    cpu_staging: ID3D11Texture2D,
    dimensions: (u32, u32),
}

#[cfg(feature = "screenshot-benchmark")]
impl Synthetic {
    pub(crate) fn new(dimensions: (u32, u32)) -> Result<Self> {
        let d3d = super::acquire_d3d()?;
        let renderer = Renderer::new(&d3d.device)?;
        let cpu_staging = create_texture(
            &d3d.device,
            dimensions,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_USAGE_STAGING,
            0,
            D3D11_CPU_ACCESS_READ.0 as u32,
            None,
        )?;
        Ok(Self {
            d3d,
            renderer,
            cpu_staging,
            dimensions,
        })
    }

    pub(crate) fn adapter(&self) -> Result<String> {
        let desc = unsafe { self.d3d.dxgi.GetAdapter()?.GetDesc()? };
        Ok(String::from_utf16_lossy(
            desc.Description
                .split(|c| *c == 0)
                .next()
                .unwrap_or_default(),
        ))
    }

    pub(crate) fn fixture(&self, bytes: &[u8]) -> Result<ID3D11Texture2D> {
        create_texture(
            &self.d3d.device,
            self.dimensions,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_USAGE_DEFAULT,
            D3D11_BIND_SHADER_RESOURCE.0 as u32,
            0,
            Some(bytes),
        )
    }

    pub(crate) fn cpu(&self, source: &ID3D11Texture2D) -> Result<DynamicImage> {
        let _guard = self.d3d.lock_context();
        let ctx = &self.d3d.context;
        unsafe {
            ctx.CopyResource(&self.cpu_staging, source);
            let image = read_mapped(ctx, &self.cpu_staging, self.dimensions, true)?;
            // The tracker baseline keeps the decoded frame cached and clones it
            // before painting a new plan on it.
            Ok(image.clone())
        }
    }

    pub(crate) fn gpu(
        &mut self,
        source: &ID3D11Texture2D,
        masks: Option<&[Rect]>,
        size: (u32, u32),
        slot: usize,
    ) -> Result<DynamicImage> {
        self.renderer.render(&self.d3d, source, masks, size, slot)
    }
}
