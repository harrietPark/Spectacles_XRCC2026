// SnapCloudARSpawnManager.js
//
// Polls Snap Cloud (Supabase) for pending AR spawn requests and instantiates
// the requested GLB so it floats in front of the user, locked to camera
// height (i.e. follows the user without tilting when they look up/down).
//
// Flow:
//   1. Web portal inserts a row into `ar_spawn_requests` with status = "pending".
//   2. This script polls for the oldest pending row.
//   3. It atomically claims the row (status=eq.pending guard) by setting
//      status = "processing".
//   4. It downloads the GLB via InternetModule + RemoteMediaModule and
//      instantiates it under this script's SceneObject. The spawned model is
//      then re-positioned each frame to sit `followDistance` cm in front of
//      `cameraObject`, at the camera's current height.
//   5. It marks the row "spawned" or "failed".
//
// Both modules below are built-in singletons; no Asset Browser wiring needed.
// The only required input is `cameraObject` (drag your scene's main Camera
// SceneObject onto it).
//
// Note on units: Lens Studio Spectacles scenes use centimetres for world
// transforms, and GLB files use metres. The spawn loader sets
// convertMetersToCentimeters=true so loaded GLBs render at their real-world
// size, and the follow distance below is expressed in centimetres.

//@input SceneObject cameraObject {"hint":"Camera SceneObject the spawned model should follow."}
//@input float followDistance = 50.0 {"hint":"Centimetres in front of the camera (50 = 0.5 m)."}
//@input bool lockToCameraHeight = true {"hint":"Match the camera's current Y so the model rises/falls with the user."}
//@input float fixedHeightOffset = 0.0 {"hint":"Centimetres added to the locked height (e.g. -10 to sit 10 cm below eye level)."}
//@input bool faceCamera = true {"hint":"Yaw the model so its forward axis points at the camera each frame."}
//@input bool replacePreviousSpawn = true {"hint":"Destroy the previously spawned model before loading a new one (prevents memory pile-up that can crash Spectacles)."}
//@input bool useAsyncInstantiate = false {"hint":"Use async GLB instantiation. Leave off if Lens Studio/Spectacles crashes during instantiate progress."}
//@input bool useGltfSettings = false {"hint":"Use GltfSettings during instantiate. Leave off if remote GLBs crash Lens Studio/Spectacles; scale is applied manually instead."}
//@input bool preflightGlb = true {"hint":"Download the GLB and reject incompatible extensions (e.g. KHR_draco_mesh_compression) before instantiating. Required for IKEA dimma assets which crash the native loader."}
//@input float pollIntervalSeconds = 1.5
//@input string supabaseUrl = "https://kcjjdcpcivyeohapnmeu.snapcloud.dev"
//@input string supabaseAnonKey {"widget":"textArea"}
//@input string tableName = "ar_spawn_requests"
//@input bool debugLogs = true {"hint":"Enable verbose per-step logs (HTTP requests, spawn pipeline, progress). Errors and outcomes are always logged."}

var TAG = "[SnapCloudARSpawnManager]";

// Built-in modules (no Asset Browser wiring needed).
//   - InternetModule : fetch + makeResourceFromUrl
//   - RemoteMediaModule : loadResourceAsGltfAsset
var internetModule = require("LensStudio:InternetModule");
var remoteMediaModule = require("LensStudio:RemoteMediaModule");

var isPolling = false;
var spawnInFlight = false;
var pollTimer = null;
var pollIntervalActive = 1.5;
var followedObjects = []; // SceneObject[] currently tracking the camera

function pausePolling() {
    if (pollTimer) {
        pollTimer.reset(999999.0);
    }
}

function resumePolling() {
    if (pollTimer) {
        pollTimer.reset(pollIntervalActive);
    }
}

function destroyAllFollowedObjects() {
    for (var i = 0; i < followedObjects.length; i++) {
        var obj = followedObjects[i];
        if (!obj) {
            continue;
        }
        var alive = true;
        if (typeof obj.isDestroyed === "function") {
            alive = !obj.isDestroyed();
        }
        if (alive) {
            try {
                obj.destroy();
            } catch (e) {
                log("Failed to destroy previous spawn: " + describeError(e));
            }
        }
    }
    followedObjects = [];
}

function log(message) {
    print(TAG + " " + message);
}

// Gated by the `debugLogs` input. Use for verbose per-step traces; reserve
// `log()` for errors, startup info, and high-signal outcomes.
function debugLog(message) {
    if (script.debugLogs) {
        print(TAG + " " + message);
    }
}

function describeError(err) {
    if (err === null || err === undefined) {
        return "<null/undefined>";
    }
    if (typeof err === "string") {
        return err;
    }
    try {
        var msg = err.message ? err.message : ("" + err);
        if (err.stack) {
            msg += "\n  stack: " + err.stack;
        }
        return msg;
    } catch (e) {
        return "<unstringifiable error>";
    }
}

// ---------------------------------------------------------------- networking

function buildHeaders(extra) {
    var headers = {
        "apikey": script.supabaseAnonKey,
        "Authorization": "Bearer " + script.supabaseAnonKey,
        "Content-Type": "application/json"
    };
    if (extra) {
        for (var key in extra) {
            headers[key] = extra[key];
        }
    }
    return headers;
}

// fetch(resource, options) accepts a URL string for `resource`. We use this
// signature instead of `new Request(...)` because some Lens Studio runtimes
// reject the Request object passed to fetch with "Incorrect argument type".
function requestJson(url, method, body, extraHeaders, onSuccess, onError) {
    if (!internetModule) {
        onError("InternetModule unavailable (require failed).");
        return;
    }

    var options = {
        method: method,
        headers: buildHeaders(extraHeaders)
    };
    if (body !== null && body !== undefined) {
        options.body = JSON.stringify(body);
    }

    debugLog("HTTP " + method + " " + url);
    internetModule.fetch(url, options)
        .then(function (response) {
            debugLog("HTTP " + method + " -> status=" + response.status + " ok=" + response.ok);
            if (!response.ok) {
                return response.text().then(function (errText) {
                    throw new Error("HTTP " + response.status + " from " + url + " body=" + errText);
                });
            }
            return response.text();
        })
        .then(function (text) {
            var data = text ? JSON.parse(text) : null;
            onSuccess(data);
        })
        .catch(function (error) {
            if (onError) {
                onError(describeError(error));
            } else {
                log("Request failed: " + describeError(error));
            }
        });
}

// ----------------------------------------------------------- table operations

function getPendingRequest(onSuccess, onError) {
    var url = script.supabaseUrl
        + "/rest/v1/" + script.tableName
        + "?select=id,pin_id,product_id,model_3d_url,status,created_at"
        + "&status=eq.pending"
        + "&order=created_at.asc"
        + "&limit=1";

    requestJson(url, "GET", null, null, function (rows) {
        onSuccess(rows && rows.length > 0 ? rows[0] : null);
    }, onError);
}

// Atomic claim: PATCH only if still pending. Returns true if THIS caller won
// the race (PostgREST returns the updated row thanks to Prefer: return=representation).
function claimRequest(requestId, onSuccess, onError) {
    var url = script.supabaseUrl
        + "/rest/v1/" + script.tableName
        + "?id=eq." + encodeURIComponent(requestId)
        + "&status=eq.pending";

    requestJson(
        url,
        "PATCH",
        { status: "processing" },
        { "Prefer": "return=representation" },
        function (rows) {
            onSuccess(!!(rows && rows.length > 0));
        },
        onError
    );
}

function setRequestStatus(requestId, status, onSuccess, onError) {
    var url = script.supabaseUrl
        + "/rest/v1/" + script.tableName
        + "?id=eq." + encodeURIComponent(requestId);

    requestJson(url, "PATCH", { status: status }, null, function () {
        if (onSuccess) onSuccess();
    }, onError);
}

// --------------------------------------------------------- camera-follow math

function horizontalForward(camTransform) {
    // Camera looks down its -Z axis, so its `forward` vector already points
    // out of the lens. Project to the XZ plane so head pitch doesn't drag
    // the model up or down.
    var fwd = camTransform.forward;
    var horiz = new vec3(fwd.x, 0, fwd.z);
    var lenSq = horiz.x * horiz.x + horiz.z * horiz.z;
    if (lenSq < 1e-6) {
        // Looking straight up or down: fall back to camera right rotated 90°.
        var right = camTransform.right;
        horiz = new vec3(-right.z, 0, right.x);
    }
    return horiz.normalize();
}

function updateFollowedObject(obj, camTransform) {
    var camPos = camTransform.getWorldPosition();
    var fwd = horizontalForward(camTransform);
    var distance = script.followDistance;

    var targetX = camPos.x + fwd.x * distance;
    var targetZ = camPos.z + fwd.z * distance;
    var targetY = script.lockToCameraHeight
        ? camPos.y + script.fixedHeightOffset
        : obj.getTransform().getWorldPosition().y;

    var transform = obj.getTransform();
    transform.setWorldPosition(new vec3(targetX, targetY, targetZ));

    if (script.faceCamera) {
        var toCamX = camPos.x - targetX;
        var toCamZ = camPos.z - targetZ;
        if (toCamX * toCamX + toCamZ * toCamZ > 1e-6) {
            var yaw = Math.atan2(toCamX, toCamZ);
            transform.setWorldRotation(quat.angleAxis(yaw, vec3.up()));
        }
    }
}

function onUpdate() {
    if (followedObjects.length === 0) {
        return;
    }
    var cam = script.cameraObject;
    if (!cam) {
        return;
    }
    var camTransform = cam.getTransform();
    for (var i = followedObjects.length - 1; i >= 0; i--) {
        var obj = followedObjects[i];
        var dead = !obj;
        if (!dead && typeof obj.isDestroyed === "function") {
            dead = obj.isDestroyed();
        }
        if (dead) {
            followedObjects.splice(i, 1);
            continue;
        }
        updateFollowedObject(obj, camTransform);
    }
}

// ----------------------------------------------------------------- spawning

function spawnGltf(modelUrl, onSuccess, onError) {
    if (!internetModule) {
        onError("InternetModule unavailable (require failed).");
        return;
    }
    if (!remoteMediaModule) {
        onError("RemoteMediaModule unavailable (require failed).");
        return;
    }
    if (!modelUrl) {
        onError("modelUrl is empty.");
        return;
    }

    var startNativeLoad = function () {
        debugLog("spawnGltf: requesting resource for " + modelUrl);
        var resource;
        try {
            resource = internetModule.makeResourceFromUrl(modelUrl);
        } catch (e) {
            onError("makeResourceFromUrl threw: " + describeError(e));
            return;
        }
        if (!resource) {
            onError("makeResourceFromUrl returned null for: " + modelUrl);
            return;
        }
        debugLog("spawnGltf: resource created, calling loadResourceAsGltfAsset");

        remoteMediaModule.loadResourceAsGltfAsset(
            resource,
            function (gltfAsset) {
                debugLog("spawnGltf: GLB downloaded, gltfAsset=" + (gltfAsset ? "ok" : "null"));
                if (!gltfAsset) {
                    onError("loadResourceAsGltfAsset returned null gltfAsset.");
                    return;
                }
                instantiateGltf(gltfAsset, onSuccess, onError);
            },
            function (errorMsg) {
                onError("loadResourceAsGltfAsset failed: " + describeError(errorMsg));
            }
        );
    };

    if (script.preflightGlb) {
        preflightGlbUrl(modelUrl, function (verdict) {
            if (!verdict.ok) {
                onError(verdict.reason);
                return;
            }
            debugLog("preflight: GLB looks compatible; proceeding to native load");
            startNativeLoad();
        });
    } else {
        startNativeLoad();
    }
}

function instantiateGltf(gltfAsset, onSuccess, onError) {
    var gltfSettings = null;
    try {
        if (script.useGltfSettings && typeof GltfSettings !== "undefined" && GltfSettings.create) {
            gltfSettings = GltfSettings.create();
            gltfSettings.convertMetersToCentimeters = true;
            debugLog("instantiate: GltfSettings.create() ok, convertMetersToCentimeters=true");
        } else if (!script.useGltfSettings) {
            debugLog("instantiate: useGltfSettings=false; using plain instantiate and manual scale.");
        } else {
            debugLog("instantiate: GltfSettings not available; relying on default scale.");
        }
    } catch (e) {
        log("instantiate: GltfSettings.create() threw: " + describeError(e));
        gltfSettings = null;
    }

    var parent = script.getSceneObject();
    debugLog("instantiate: parent=" + parent.name
        + " (mode=" + (script.useAsyncInstantiate ? "async" : "sync") + ")");

    var onSpawned = function (spawned) {
        if (!spawned) {
            onError("tryInstantiateAsync onSuccess called with null SceneObject.");
            return;
        }
        debugLog("instantiate: spawned SceneObject \"" + spawned.name
            + "\" with " + spawned.getChildrenCount() + " children");
        if (!script.useGltfSettings) {
            spawned.getTransform().setLocalScale(new vec3(100, 100, 100));
            debugLog("instantiate: applied manual meters-to-centimetres root scale (100x)");
        }
        followedObjects.push(spawned);
        if (script.cameraObject) {
            updateFollowedObject(spawned, script.cameraObject.getTransform());
            var pos = spawned.getTransform().getWorldPosition();
            debugLog("instantiate: positioned at (" + pos.x.toFixed(2) + ", "
                + pos.y.toFixed(2) + ", " + pos.z.toFixed(2) + ")");
        }
        onSuccess(spawned);
    };
    var onInstantiateErr = function (instantiateError) {
        onError("tryInstantiateAsync failed: " + describeError(instantiateError));
    };
    var onProgress = function (progress) {
        debugLog("instantiate: progress=" + progress);
    };

    try {
        if (script.useAsyncInstantiate && gltfSettings) {
            gltfAsset.tryInstantiateAsync(parent, null, onSpawned, onInstantiateErr, onProgress, gltfSettings);
        } else if (script.useAsyncInstantiate) {
            gltfAsset.tryInstantiateAsync(parent, null, onSpawned, onInstantiateErr, onProgress);
        } else if (gltfSettings) {
            // This is the path shown in Snap's GltfAsset docs. It blocks for a
            // moment, but avoids the native async-progress path that can crash
            // some Lens Studio/Spectacles runtimes.
            var spawnedWithSettings = gltfAsset.tryInstantiateWithSetting(parent, null, gltfSettings);
            onSpawned(spawnedWithSettings);
        } else {
            // Plainest possible path. This avoids GltfSettings, which is the
            // most likely native crash trigger for small remote GLBs here.
            debugLog("instantiate: calling plain synchronous tryInstantiate");
            var spawned = gltfAsset.tryInstantiate(parent, null);
            onSpawned(spawned);
        }
    } catch (e) {
        onError("instantiate threw: " + describeError(e));
    }
}

// ---------------------------------------------------------- GLB preflight
//
// Some remote GLBs (notably IKEA's `dimma` assets at .../glb_draco/...)
// declare `KHR_draco_mesh_compression` in `extensionsRequired`. Lens Studio's
// Spectacles runtime does not implement Draco mesh decompression, and the
// native GLTF loader crashes the process when it hits a required-but-unknown
// extension instead of returning a JS-catchable error. This preflight reads
// just the GLB header (12 bytes) and the JSON chunk to refuse incompatible
// files cheaply before any native code touches them.
var SUPPORTED_GLTF_EXTENSIONS = {
    // Mark every extension Lens Studio is known to handle. Anything outside
    // this whitelist that appears in `extensionsRequired` will be rejected.
    "KHR_materials_unlit": true,
    "KHR_texture_transform": true,
    "KHR_materials_pbrSpecularGlossiness": true,
    "KHR_materials_emissive_strength": true,
    "KHR_materials_ior": true,
    "KHR_materials_specular": true,
    "KHR_materials_clearcoat": true,
    "KHR_materials_sheen": true,
    "KHR_materials_transmission": true,
    "KHR_materials_volume": true,
    "KHR_materials_variants": true,
    "KHR_lights_punctual": true,
    "KHR_mesh_quantization": true
};

function readUint32LE(arr, offset) {
    return (arr[offset]) |
           (arr[offset + 1] << 8) |
           (arr[offset + 2] << 16) |
           (arr[offset + 3] << 24) >>> 0;
}

function bytesToString(arr, start, length) {
    var s = "";
    var end = start + length;
    for (var i = start; i < end; i++) {
        s += String.fromCharCode(arr[i]);
    }
    return s;
}

// Returns { ok: true } if the GLB looks safe to instantiate, or
// { ok: false, reason: "..." } if it declares a required extension we know
// crashes the runtime.
function inspectGlbBytes(bytes) {
    if (!bytes || bytes.length < 20) {
        return { ok: false, reason: "GLB too short to be valid (got " + (bytes ? bytes.length : 0) + " bytes)." };
    }
    var magic = bytesToString(bytes, 0, 4);
    if (magic !== "glTF") {
        return { ok: false, reason: "File is not a GLB (magic='" + magic + "')." };
    }
    var version = readUint32LE(bytes, 4);
    if (version !== 2) {
        return { ok: false, reason: "Unsupported GLB version " + version + " (expected 2)." };
    }
    var jsonChunkLen = readUint32LE(bytes, 12);
    var jsonChunkType = bytesToString(bytes, 16, 4);
    if (jsonChunkType.indexOf("JSON") === -1) {
        return { ok: false, reason: "First chunk is not JSON (got '" + jsonChunkType + "')." };
    }
    if (20 + jsonChunkLen > bytes.length) {
        return { ok: false, reason: "JSON chunk length " + jsonChunkLen + " exceeds file size." };
    }
    var jsonText = bytesToString(bytes, 20, jsonChunkLen);
    var meta;
    try {
        meta = JSON.parse(jsonText);
    } catch (e) {
        return { ok: false, reason: "Could not parse GLB JSON chunk: " + describeError(e) };
    }
    var required = meta.extensionsRequired || [];
    for (var i = 0; i < required.length; i++) {
        if (!SUPPORTED_GLTF_EXTENSIONS[required[i]]) {
            return {
                ok: false,
                reason: "GLB requires unsupported extension \"" + required[i]
                    + "\". Lens Studio cannot instantiate this file. (extensionsRequired="
                    + JSON.stringify(required) + ")"
            };
        }
    }
    return { ok: true, meta: meta };
}

// Downloads `modelUrl` as raw bytes via InternetModule.fetch and runs
// inspectGlbBytes on the result. `onResult({ok, reason?, meta?})` is called
// once with the verdict.
function preflightGlbUrl(modelUrl, onResult) {
    if (!internetModule) {
        onResult({ ok: false, reason: "InternetModule unavailable for preflight." });
        return;
    }
    debugLog("preflight: fetching GLB bytes for inspection");
    internetModule.fetch(modelUrl, { method: "GET" })
        .then(function (response) {
            if (!response.ok) {
                throw new Error("Preflight HTTP " + response.status + " from " + modelUrl);
            }
            return response.bytes();
        })
        .then(function (bytes) {
            debugLog("preflight: " + bytes.length + " bytes downloaded; inspecting");
            onResult(inspectGlbBytes(bytes));
        })
        .catch(function (error) {
            onResult({ ok: false, reason: "Preflight fetch failed: " + describeError(error) });
        });
}

// ----------------------------------------------------------------- pipeline

function processRequest(request) {
    if (!request || !request.id) {
        return;
    }
    if (!request.model_3d_url) {
        log("Request " + request.id + " has no model_3d_url; marking failed.");
        setRequestStatus(request.id, "failed");
        return;
    }
    if (spawnInFlight) {
        return;
    }

    debugLog("Claiming request " + request.id + " (product_id=" + request.product_id
        + ", url=" + request.model_3d_url + ")");
    claimRequest(request.id, function (won) {
        if (!won) {
            debugLog("Claim lost for " + request.id + " (already taken).");
            return;
        }
        debugLog("Claim ok. Beginning spawn for " + request.id);
        spawnInFlight = true;
        // Pause polling so we don't fight the GPU/RAM during instantiate.
        // Heavy GLBs (e.g. IKEA dimma assets) can already push Spectacles to
        // its memory ceiling; concurrent network traffic makes crashes likely.
        pausePolling();
        if (script.replacePreviousSpawn) {
            destroyAllFollowedObjects();
        }
        spawnGltf(request.model_3d_url, function () {
            spawnInFlight = false;
            log("Spawn SUCCESS for " + request.id + ", marking row spawned.");
            setRequestStatus(request.id, "spawned");
            resumePolling();
        }, function (error) {
            spawnInFlight = false;
            log("Spawn FAILED for " + request.id + ": " + error);
            setRequestStatus(request.id, "failed");
            resumePolling();
        });
    }, function (error) {
        log("Could not claim " + request.id + ": " + error);
    });
}

function pollOnce() {
    if (isPolling || spawnInFlight) {
        return;
    }
    isPolling = true;
    getPendingRequest(function (request) {
        isPolling = false;
        if (request) {
            processRequest(request);
        }
    }, function (error) {
        isPolling = false;
        log("Polling failed: " + error);
    });
}

function startPolling() {
    log("Starting up (debugLogs=" + (script.debugLogs ? "on" : "off") + ").");
    debugLog("================ startup ================");
    debugLog("internetModule: " + (internetModule ? "ok" : "MISSING"));
    debugLog("remoteMediaModule: " + (remoteMediaModule ? "ok" : "MISSING"));
    debugLog("cameraObject input: " + (script.cameraObject ? script.cameraObject.name : "NOT SET"));
    debugLog("supabaseUrl: " + (script.supabaseUrl || "NOT SET"));
    debugLog("supabaseAnonKey set: " + (script.supabaseAnonKey ? "yes (len=" + script.supabaseAnonKey.length + ")" : "NO"));
    debugLog("tableName: " + (script.tableName || "NOT SET"));
    debugLog("pollIntervalSeconds: " + script.pollIntervalSeconds);
    debugLog("followDistance (cm): " + script.followDistance
        + " | lockToCameraHeight: " + script.lockToCameraHeight
        + " | fixedHeightOffset: " + script.fixedHeightOffset
        + " | faceCamera: " + script.faceCamera
        + " | replacePreviousSpawn: " + script.replacePreviousSpawn
        + " | useAsyncInstantiate: " + script.useAsyncInstantiate
        + " | useGltfSettings: " + script.useGltfSettings
        + " | preflightGlb: " + script.preflightGlb);
    debugLog("=========================================");

    if (!internetModule) {
        log("InternetModule unavailable; aborting startup.");
        return;
    }
    if (!remoteMediaModule) {
        log("RemoteMediaModule unavailable; spawning will fail.");
    }
    if (!script.cameraObject) {
        log("cameraObject input not set; spawned models will not follow the user.");
    }
    if (!script.supabaseUrl || !script.supabaseAnonKey) {
        log("Supabase URL or anon key not set; aborting startup.");
        return;
    }
    if (!script.tableName) {
        log("Table name not set; aborting startup.");
        return;
    }

    var interval = script.pollIntervalSeconds > 0 ? script.pollIntervalSeconds : 1.5;
    pollIntervalActive = interval;
    debugLog("Polling " + script.tableName + " every " + interval + "s.");

    pollTimer = script.createEvent("DelayedCallbackEvent");
    pollTimer.bind(function () {
        pollOnce();
        // Only schedule the next tick if we're not in the middle of a spawn.
        // pausePolling() disables the timer; resumePolling() re-arms it.
        if (!spawnInFlight) {
            pollTimer.reset(pollIntervalActive);
        }
    });

    pollOnce();
    pollTimer.reset(pollIntervalActive);
}

script.createEvent("OnStartEvent").bind(startPolling);
script.createEvent("UpdateEvent").bind(onUpdate);
