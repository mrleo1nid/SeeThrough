using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

// NOTE: Namespace must NOT contain "SwarmUI" (reserved for built-ins).
namespace SeeThrough.SwarmExtension;

/// <summary>Extension that wraps the "See-through" ComfyUI nodes (jtydhr88/ComfyUI-See-through) to decompose a single
/// anime illustration into depth-ordered semantic RGBA layers, with a browser-side PSD export for Live2D workflows.</summary>
public partial class SeeThroughExtension : Extension
{
    /// <summary>Default HuggingFace repo ID for the LayerDiff (SDXL layer generation) model.</summary>
    public const string DefaultLayerDiffRepo = "layerdifforg/seethroughv0.0.2_layerdiff3d";

    /// <summary>Default HuggingFace repo ID for the Marigold depth model.</summary>
    public const string DefaultDepthRepo = "layerdifforg/seethroughv0.0.1_marigold";

    /// <summary>Permission for using the See-through decomposition tool.</summary>
    public static PermInfo PermUseSeeThrough = Permissions.Register(new("seethrough_decompose", "[See-through] Decompose Images",
        "Allows the user to run the See-through layer-decomposition tool.", PermissionDefault.USER, Permissions.GroupUser));

    /// <summary>Registers web assets (JS/CSS) onto the main page. Runs early in startup.</summary>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/ag-psd.bundle.js");
        ScriptFiles.Add("Assets/seethrough.js");
        StyleSheetFiles.Add("Assets/seethrough.css");
    }

    /// <summary>Registers the installable node pack and the backend API routes. Runs during main init.</summary>
    public override void OnInit()
    {
        Logs.Init("[See-through] Extension loading.");
        InstallableFeatures.RegisterInstallableFeature(new("See-through Layer Decomposition", "seethrough",
            "https://github.com/jtydhr88/ComfyUI-See-through", "jtydhr88",
            "This will install https://github.com/jtydhr88/ComfyUI-See-through, a third-party ComfyUI node pack by community developer 'jtydhr88'.\n"
            + "It pulls in heavy Python dependencies (diffusers, bitsandbytes, etc.) and, on first run, downloads several GB of models from HuggingFace.\n"
            + "We cannot make any guarantees about it.\nDo you wish to install?"));
        API.RegisterAPICall(SeeThroughDecompose, true, PermUseSeeThrough);
        API.RegisterAPICall(SeeThroughListModels, false, PermUseSeeThrough);
    }
}
