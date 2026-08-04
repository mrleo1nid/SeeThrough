using System;
using System.Linq;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

namespace SeeThrough.SwarmExtension;

public partial class SeeThroughExtension
{
    /// <summary>API route: lists the model options exposed by the See-through loader nodes (local folders + HuggingFace defaults).
    /// Falls back to the built-in defaults if the node pack is not installed or the backend is unreachable.</summary>
    public async Task<JObject> SeeThroughListModels(Session session)
    {
        JArray layerModels = new() { DefaultLayerDiffRepo };
        JArray depthModels = new() { DefaultDepthRepo };
        ComfyUIAPIAbstractBackend backend = ComfyUIBackendExtension.RunningComfyBackends.FirstOrDefault();
        if (backend is not null)
        {
            layerModels = await GetNodeModelList(backend, "SeeThrough_LoadLayerDiffModel", DefaultLayerDiffRepo);
            depthModels = await GetNodeModelList(backend, "SeeThrough_LoadDepthModel", DefaultDepthRepo);
        }
        return new JObject()
        {
            ["layer_models"] = layerModels,
            ["depth_models"] = depthModels
        };
    }

    /// <summary>Queries a backend's object_info for a given node's "model" input options.</summary>
    public static async Task<JArray> GetNodeModelList(ComfyUIAPIAbstractBackend backend, string node, string fallback)
    {
        try
        {
            string raw = await ComfyUIAPIAbstractBackend.HttpClient.GetStringAsync($"{backend.APIAddress}/object_info/{node}", Program.GlobalProgramCancel);
            JObject parsed = raw.ParseToJson();
            if (ComfyUIBackendExtension.TryGetRequiredInputs(parsed, node, "model", out JToken list) && list is JArray arr && arr.Count > 0)
            {
                return arr;
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"[See-through] Could not read model list for '{node}': {ex.Message}");
        }
        return new JArray() { fallback };
    }

    /// <summary>API route (websocket): runs the full See-through decomposition pipeline on a single image, streaming a blended
    /// preview and progress, then returns every decomposed layer (base64 PNG) plus the depth-ordering manifest for PSD export.</summary>
    public async Task<JObject> SeeThroughDecompose(WebSocket socket, Session session,
        string imageData, string layerModel, string depthModel, string quantMode,
        long seed, int resolution, int steps, int resolutionDepth,
        bool tblrSplit, bool useLama, bool groupOffload, bool cacheTagEmbeds, bool autoDownload,
        string vaeCkpt, string unetCkpt)
    {
        // Normalize inputs.
        if (string.IsNullOrWhiteSpace(imageData))
        {
            await socket.SendJson(new JObject() { ["error"] = "No image provided." }, API.WebsocketTimeout);
            return null;
        }
        if (imageData.StartsWithFast("data:"))
        {
            imageData = imageData.After(',');
        }
        if (string.IsNullOrWhiteSpace(layerModel))
        {
            layerModel = DefaultLayerDiffRepo;
        }
        if (string.IsNullOrWhiteSpace(depthModel))
        {
            depthModel = DefaultDepthRepo;
        }
        if (quantMode != "nf4")
        {
            quantMode = "none";
        }
        resolution = Math.Clamp(resolution, 512, 2048);
        steps = Math.Clamp(steps, 1, 100);
        // A unique prefix per run keeps the on-disk layer files from colliding across users/runs.
        string prefix = $"seethrough_{Utilities.StrictFilenameClean(session.User.UserID)}_{Environment.TickCount64}";

        JObject workflow = new()
        {
            ["1"] = new JObject()
            {
                ["class_type"] = "SeeThrough_LoadLayerDiffModel",
                ["inputs"] = new JObject()
                {
                    ["model"] = layerModel,
                    ["quant_mode"] = quantMode,
                    ["cache_tag_embeds"] = cacheTagEmbeds,
                    ["group_offload"] = groupOffload,
                    ["auto_download"] = autoDownload,
                    ["vae_ckpt"] = vaeCkpt ?? "",
                    ["unet_ckpt"] = unetCkpt ?? ""
                }
            },
            ["2"] = new JObject()
            {
                ["class_type"] = "SeeThrough_LoadDepthModel",
                ["inputs"] = new JObject()
                {
                    ["model"] = depthModel,
                    ["quant_mode"] = quantMode,
                    ["cache_tag_embeds"] = cacheTagEmbeds,
                    ["group_offload"] = groupOffload,
                    ["auto_download"] = autoDownload
                }
            },
            ["3"] = new JObject()
            {
                ["class_type"] = "SwarmLoadImageB64",
                ["inputs"] = new JObject()
                {
                    ["image_base64"] = imageData
                }
            },
            ["4"] = new JObject()
            {
                ["class_type"] = "SeeThrough_GenerateLayers",
                ["inputs"] = new JObject()
                {
                    ["image"] = new JArray() { "3", 0 },
                    ["layerdiff_model"] = new JArray() { "1", 0 },
                    ["seed"] = seed,
                    ["resolution"] = resolution,
                    ["num_inference_steps"] = steps
                }
            },
            ["5"] = new JObject()
            {
                ["class_type"] = "SeeThrough_GenerateDepth",
                ["inputs"] = new JObject()
                {
                    ["layers"] = new JArray() { "4", 0 },
                    ["depth_model"] = new JArray() { "2", 0 },
                    ["seed"] = seed,
                    ["resolution_depth"] = resolutionDepth
                }
            },
            ["6"] = new JObject()
            {
                ["class_type"] = "SeeThrough_PostProcess",
                ["inputs"] = new JObject()
                {
                    ["layers_depth"] = new JArray() { "5", 0 },
                    ["tblr_split"] = tblrSplit,
                    ["use_lama"] = useLama
                }
            },
            ["7"] = new JObject()
            {
                ["class_type"] = "SeeThrough_SavePSD",
                ["inputs"] = new JObject()
                {
                    ["parts"] = new JArray() { "6", 0 },
                    ["filename_prefix"] = prefix
                }
            },
            // Node id 9 is treated by Swarm as a "real" final output, so the (post-process) blended preview streams to the UI.
            ["9"] = new JObject()
            {
                ["class_type"] = "SwarmSaveImageWS",
                ["inputs"] = new JObject()
                {
                    ["images"] = new JArray() { "6", 1 }
                }
            },
            // Intermediate stage previews. Node ids >= 50000 are treated as non-final by Swarm, but still stream back with
            // their node id as a hint, which lets us report exact per-stage progress ("layers done" -> "depth done").
            ["50001"] = new JObject()
            {
                ["class_type"] = "SwarmSaveImageWS",
                ["inputs"] = new JObject()
                {
                    ["images"] = new JArray() { "4", 1 }
                }
            },
            ["50002"] = new JObject()
            {
                ["class_type"] = "SwarmSaveImageWS",
                ["inputs"] = new JObject()
                {
                    ["images"] = new JArray() { "5", 1 }
                }
            }
        };

        await API.RunWebsocketHandlerCallWS<object>(async (Session s, object t, Action<JObject> send, bool isNew) =>
        {
            ComfyUIAPIAbstractBackend backend = ComfyUIBackendExtension.RunningComfyBackends.FirstOrDefault()
                ?? throw new SwarmUserErrorException("No available ComfyUI backend to run See-through.");
            send(new JObject() { ["status"] = "Generating layers (this can take several minutes)...", ["stage"] = "layers" });
            long ticks = Environment.TickCount64;
            await backend.AwaitJobLive(workflow.ToString(), "0", data =>
            {
                if (data is T2IEngine.ImageOutput img)
                {
                    // The node id that produced the image tells us exactly which pipeline stage just finished.
                    JObject message = new() { ["preview_image"] = img.File.AsDataString() };
                    switch (img.BackendInternalHint)
                    {
                        case "50001":
                            message["status"] = "Estimating depth...";
                            message["stage"] = "depth";
                            break;
                        case "50002":
                            message["status"] = "Post-processing (splitting & ordering layers)...";
                            message["stage"] = "postprocess";
                            break;
                        case "9":
                            message["status"] = "Finalizing...";
                            message["stage"] = "finalize";
                            break;
                    }
                    send(message);
                }
                else if (data is JObject jData && jData.ContainsKey("overall_percent"))
                {
                    long newTicks = Environment.TickCount64;
                    if (newTicks - ticks > 500)
                    {
                        ticks = newTicks;
                        send(new JObject() { ["overall_percent"] = jData["overall_percent"] });
                    }
                }
            }, new(null), Program.GlobalProgramCancel);
            send(new JObject() { ["status"] = "Collecting decomposed layers..." });
            JObject manifest = await FetchLayerManifest(backend, Program.GlobalProgramCancel);
            if (manifest is null)
            {
                send(new JObject() { ["error"] = "Decomposition finished but no layer output was found. Check the server logs (is the See-through node pack installed?)." });
                return;
            }
            send(new JObject() { ["layers_info"] = manifest });
            send(new JObject() { ["success"] = true });
        }, session, null, socket);
        return null;
    }

    /// <summary>After a run, reads the See-through output manifest (via the backend's /view endpoint) and inlines every layer
    /// PNG (and depth PNG, when present) as a base64 data URL so the browser can display them and build a PSD offline.</summary>
    public static async Task<JObject> FetchLayerManifest(ComfyUIAPIAbstractBackend backend, CancellationToken cancel)
    {
        string viewBase = backend.APIAddress;
        string manifestName;
        try
        {
            manifestName = (await ComfyUIAPIAbstractBackend.HttpClient.GetStringAsync($"{viewBase}/view?filename=seethrough_psd_info.log&type=output", cancel)).Trim();
        }
        catch (Exception ex)
        {
            Logs.Error($"[See-through] Failed to read layer info log: {ex.Message}");
            return null;
        }
        if (string.IsNullOrWhiteSpace(manifestName))
        {
            return null;
        }
        JObject manifest;
        try
        {
            string raw = await ComfyUIAPIAbstractBackend.HttpClient.GetStringAsync($"{viewBase}/view?filename={Uri.EscapeDataString(manifestName)}&type=output", cancel);
            manifest = raw.ParseToJson();
        }
        catch (Exception ex)
        {
            Logs.Error($"[See-through] Failed to read layer manifest '{manifestName}': {ex.Message}");
            return null;
        }
        if (manifest?["layers"] is not JArray layers)
        {
            return null;
        }
        foreach (JToken layerTok in layers)
        {
            if (layerTok is not JObject layer)
            {
                continue;
            }
            string filename = layer.Value<string>("filename");
            if (!string.IsNullOrWhiteSpace(filename))
            {
                string dataUrl = await FetchAsDataUrl(viewBase, filename, cancel);
                if (dataUrl is not null)
                {
                    layer["dataurl"] = dataUrl;
                }
            }
            string depthFilename = layer.Value<string>("depth_filename");
            if (!string.IsNullOrWhiteSpace(depthFilename))
            {
                string depthUrl = await FetchAsDataUrl(viewBase, depthFilename, cancel);
                if (depthUrl is not null)
                {
                    layer["depth_dataurl"] = depthUrl;
                }
            }
        }
        return manifest;
    }

    /// <summary>Fetches a file from a ComfyUI backend's /view output endpoint and returns it as a base64 PNG data URL.</summary>
    public static async Task<string> FetchAsDataUrl(string viewBase, string filename, CancellationToken cancel)
    {
        try
        {
            byte[] bytes = await ComfyUIAPIAbstractBackend.HttpClient.GetByteArrayAsync($"{viewBase}/view?filename={Uri.EscapeDataString(filename)}&type=output", cancel);
            return $"data:image/png;base64,{Convert.ToBase64String(bytes)}";
        }
        catch (Exception ex)
        {
            Logs.Warning($"[See-through] Failed to fetch layer file '{filename}': {ex.Message}");
            return null;
        }
    }
}
