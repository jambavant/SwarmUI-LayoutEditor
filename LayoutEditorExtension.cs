using SwarmUI.Core;
using SwarmUI.Utils;

// NOTE: the namespace must not contain "SwarmUI" (reserved for built-in extensions).
namespace LayoutEditorExt;

/// <summary>Visual bounding-box layout editor for layout prompts (MOSS-Image first).
/// All the work happens in the browser: this class only registers the web assets.</summary>
public class LayoutEditorExtension : Extension
{
    /// <summary>Registers the editor's scripts and stylesheets (loaded on the Generate page) and the standalone page.</summary>
    public override void OnPreInit()
    {
        // Order matters: the core defines the LayoutEditor namespace that the Swarm host script uses.
        ScriptFiles.Add("Assets/core/le-model.js");
        ScriptFiles.Add("Assets/core/le-formats.js");
        ScriptFiles.Add("Assets/core/le-validate.js");
        ScriptFiles.Add("Assets/core/le-editor.js");
        ScriptFiles.Add("Assets/swarm-layout-editor.js");
        StyleSheetFiles.Add("Assets/core/le-editor.css");
        StyleSheetFiles.Add("Assets/swarm-layout-editor.css");
        // The standalone page, served at /ExtensionFile/LayoutEditorExtension/standalone/index.html
        // (the URL segment is this class's name).
        OtherAssets.Add("standalone/index.html");
    }

    /// <summary>Logs that the extension is loaded. Nothing else to register: the editor runs entirely in the browser.</summary>
    public override void OnInit()
    {
        Logs.Init("Layout Editor extension loaded.");
    }
}
