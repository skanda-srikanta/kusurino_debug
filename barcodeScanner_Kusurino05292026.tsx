"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import * as CortexDecoder from "@q0191/codecorp-web_sdk";
import { HandleBarcodeType, ScanMethodType } from "@/types";
import extractExpiryAndLot from "@/utils/barcode";
import { apiClient } from "@/lib/axios";
import { BRADY_USE_SERVER } from "@/consts";
import CustomError from "@/utils/customError";

// Multi-scan settings
const MAX_BARCODES_TO_DECODE = 10; // Maximum number of barcodes to decode simultaneously
const EXACT_MATCH = false; // false: returns results even if fewer than the specified number are found
const DUPLICATE_DELAY_MS = 500; // Interval to prevent re-decoding the same barcode (ms). Recommended by Brady.

interface BarcodeResult {
  data: string;
  compositeData: string;
  symbology: string;
}

// SDK state managed as a module-level singleton
let isSDKInitialized = false;
let initializationPromise: Promise<void> | null = null;
let isCameraStreamActive = false;
let cameraOperationLock: Promise<void> = Promise.resolve();

/**
 * Lock to serialize camera operations
 */
async function withCameraLock<T>(operation: () => Promise<T>): Promise<T> {
  const previousLock = cameraOperationLock;
  let resolve: () => void = () => {};
  cameraOperationLock = new Promise<void>((r) => {
    resolve = r;
  });

  try {
    await previousLock;
    return await operation();
  } finally {
    resolve();
  }
}

/**
 * SDK Initialization (WASM loading, executed only once)
 */
async function initializeSDK(): Promise<void> {
  if (isSDKInitialized) {
    return;
  }

  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  initializationPromise = (async () => {
    try {
      await CortexDecoder.CDDecoder.init("/wasm/");
      isSDKInitialized = true;
    } catch (err) {
      initializationPromise = null;
      throw err;
    }
  })();

  await initializationPromise;
}

/**
 * Performs license authentication only.
 * Since activateLicense does not throw an exception on failure,
 * explicitly check current license status via checkLicense() and throw if not authenticated.
 * Call configureDecoder() after successful authentication to apply SDK settings
 * (as activateLicense resets SDK configurations).
 */
async function authenticateLicense(licenseKey: string): Promise<void> {
  await CortexDecoder.CDLicense.activateLicense(licenseKey);
  const status = CortexDecoder.CDLicense.checkLicense();
  if (status !== "ACTIVATED" && status !== "VALID") {
    throw new Error(`License authentication failed: ${status}`);
  }
}

/**
 * Applies various SDK settings.
 * Intended to be called immediately after authenticateLicense()
 * (requires re-application every time as activateLicense resets settings).
 */
async function configureDecoder(): Promise<void> {
  CortexDecoder.CDDevice.audio = false;
  CortexDecoder.CDDevice.vibration = false;

  // Enable only required symbologies
  const cdSymbology = new CortexDecoder.CDSymbology();
  cdSymbology.GS1Databar.enable = true;
  cdSymbology.Code128.enable = true;

  cdSymbology.QR.enable = false;
  cdSymbology.DataMatrix.enable = false;
  cdSymbology.Aztec.enable = false;
  cdSymbology.MaxiCode.enable = false;
  cdSymbology.DotCode.enable = false;
  cdSymbology.GridMatrix.enable = false;
  cdSymbology.HanXinCode.enable = false;
  cdSymbology.HongKong2of5.enable = false;
  cdSymbology.IATA2of5.enable = false;
  cdSymbology.Interleaved2of5.enable = false;
  cdSymbology.Matrix2of5.enable = false;
  cdSymbology.Straight2of5.enable = false;
  cdSymbology.NEC2of5.enable = false;
  cdSymbology.Codabar.enable = false;
  cdSymbology.Code11.enable = false;
  cdSymbology.Code32.enable = false;
  cdSymbology.Code39.enable = false;
  cdSymbology.Code49.enable = false;
  cdSymbology.Code93.enable = false;

  cdSymbology.CompositeCode.enable = false;
  cdSymbology.CodablockF.enable = false;
  cdSymbology.EAN13.enable = false;
  cdSymbology.UPCA.enable = false;
  cdSymbology.EAN8.enable = false;
  cdSymbology.UPCE.enable = false;
  cdSymbology.Trioptic.enable = false;
  cdSymbology.Telepen.enable = false;
  cdSymbology.Plessey.enable = false;
  cdSymbology.PDF417.enable = false;
  cdSymbology.MSIPlessey.enable = false;
  cdSymbology.AustraliaPost.enable = false;
  cdSymbology.CanadaPost.enable = false;
  cdSymbology.DutchPost.enable = false;
  cdSymbology.JapanPost.enable = false;
  cdSymbology.KoreaPost.enable = false;
  cdSymbology.RoyalMail.enable = false;
  cdSymbology.UPU.enable = false;
  cdSymbology.USPSIntelligent.enable = false;
  cdSymbology.USPSPlanet.enable = false;
  cdSymbology.USPSPostnet.enable = false;

  // Enable for low-contrast printing
  CortexDecoder.CDPerformanceFeatures.lowContrast = true;

  // setDuplicateDelay only passes the setter when the SDK internal flag Bo===1.
  // Temporarily align to single mode (value=1, exactMatch=true) to set Bo=1 before configuring.
  // Revert to multi-code settings afterward; stored delay values persist even if Bo returns to 0.
  await CortexDecoder.CDDecoder.setBarcodesToDecode(1, true);
  CortexDecoder.CDDecoder.setDuplicateDelay(DUPLICATE_DELAY_MS);
  await CortexDecoder.CDDecoder.setBarcodesToDecode(MAX_BARCODES_TO_DECODE, EXACT_MATCH);
}

/**
 * Fetch license key (throws if empty)
 */
async function fetchLicenseKey(): Promise<string> {
  const res = await apiClient.v1.brady_license.get({ query: { use_server: BRADY_USE_SERVER } });
  const licenseKey = res.body.license_key ?? "";
  if (!licenseKey) {
    throw new Error("Could not retrieve license key for the barcode scanner");
  }
  return licenseKey;
}

/**
 * Determines if a camera initialization failure is due to "Permission Denied".
 * Since the SDK throws an Error with a specific string ("Camera access was denied...") 
 * rather than a DOMException, we use string matching.
 * Combined with standard patterns for DOMException and potential localization.
 */
function isCameraPermissionError(e: unknown): boolean {
  if (e instanceof DOMException) {
    return e.name === "NotAllowedError" || e.name === "PermissionDeniedError";
  }
  if (e instanceof Error && e.message) {
    return /NotAllowed|PermissionDenied|Permission\s*denied|access\s+was\s+denied/i.test(e.message);
  }
  return false;
}

/**
 * Camera initialization and startup (with lock)
 */
async function startCameraWithLock(
  videoElement: HTMLVideoElement,
  canvasElement: HTMLCanvasElement,
  onResults: (results: CortexDecoder.CDResult[]) => void
): Promise<void> {
  return withCameraLock(async () => {
    if (isCameraStreamActive) {
      return;
    }

    // Propagate exceptions as-is for the caller to handle permission issues, etc.
    await CortexDecoder.CDCamera.init(videoElement);
    await CortexDecoder.CDCamera.setHighlightBarcodes(true);
    await CortexDecoder.CDCamera.setResolution(CortexDecoder.CDResolution.RES3840x2160);

    // Prioritize back triple camera; fallback to back then front
    const cameras = CortexDecoder.CDCamera.getConnectedCameras();
    const tripleCamera = cameras.find((cam) => cam.label.includes("背面トリプルカメラ"));
    if (tripleCamera) {
      await CortexDecoder.CDCamera.setCamera(tripleCamera);
    } else {
      const hasBackCamera = cameras.some(
        (cam) =>
          cam.label.toLowerCase().includes("back") ||
          cam.label.toLowerCase().includes("rear") ||
          cam.label.includes("背面") ||
          cam.label.includes("環境")
      );
      if (hasBackCamera) {
        await CortexDecoder.CDCamera.setCameraPosition(CortexDecoder.CDPosition.BACK, false);
      } else {
        await CortexDecoder.CDCamera.setCameraPosition(CortexDecoder.CDPosition.FRONT, false);
      }
    }

    await CortexDecoder.CDCamera.startCamera();
    await CortexDecoder.CDCamera.startPreview(onResults);

    CortexDecoder.CDDecoder.decoding = true;

    // Set autofocus for supported devices
    if (CortexDecoder.CDCamera.isFocusSupported()) {
      CortexDecoder.CDCamera.setFocus(CortexDecoder.CDFocus.AUTO);
    }

    isCameraStreamActive = true;
  });
}

/**
 * Stop camera (with lock)
 */
async function stopCameraWithLock(): Promise<void> {
  return withCameraLock(async () => {
    if (!isCameraStreamActive) {
      return;
    }

    try {
      CortexDecoder.CDDecoder.decoding = false;
      await CortexDecoder.CDCamera.stopCamera();
      isCameraStreamActive = false;
    } catch {
      isCameraStreamActive = false;
    }
  });
}

/**
 * Barcode Scanner Component
 * @param handleBarcode Callback for scan results
 * @param scanMethodType Toggle between single/multi scan
 * @param isCameraActive Camera on/off state
 * @param setIsScannerVisible Function to update camera visibility
 * @param errorLink Redirect URL for error pages
 * @param errorLinkText Button text for error pages
 */
export default function BarcodeScanner(barcodeProps: {
  handleBarcode: HandleBarcodeType;
  scanMethodType: ScanMethodType;
  isCameraActive: boolean;
  setIsScannerVisible: (isActive: boolean) => void;
  errorLink: string;
  errorLinkText: string;
}) {
  const { handleBarcode, scanMethodType, isCameraActive, setIsScannerVisible, errorLink, errorLinkText } = barcodeProps;
  const [isInit, setIsInit] = useState<boolean>(false);
  // Async throws in useEffect don't reach Error Boundaries, so re-throw via state
  const [initError, setInitError] = useState<CustomError | null>(null);
  if (initError) throw initError;
  
  // Barcodes scanned in session (duplicate prevention)
  const scannedSetRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef<boolean>(true);
  // Prevent duplicate useEffect execution
  const hasInitializedRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Maintain latest reference via ref to exclude from useEffect dependency array
  const handleMultipleBarcodesRef = useRef<(results: CortexDecoder.CDResult[]) => void>(() => {});

  // Barcode data processing
  const processBarcode = useCallback((data: string, symbology: string): BarcodeResult => {
    const normalizedData = data.replace(/\(|\)/g, ""); // Handle "(01)" -> "01"

    // GS1-128 check: Symbology is Code128 and starts with 01 + 14 digits
    const isCode128 = symbology.toLowerCase().replace(/\s/g, "").includes("code128");
    if (isCode128 && /^01\d{14}/.test(normalizedData)) {
      // GS1-128: 01 + 14 digits
      const gtin = normalizedData.slice(0, 16);

      // Parse compositeData to split into Expiry Date + Lot Number
      const { expiryDate, lotNumber } = extractExpiryAndLot(normalizedData);
      // Construct compositeData by combining expiry and lot
      const formattedComposedData = `${expiryDate ?? ""}${lotNumber ?? ""}`;

      return {
        data: gtin,
        compositeData: formattedComposedData,
        symbology,
      };
    }

    return { data, compositeData: "", symbology };
  }, []);

  // Handle barcode results
  const handleMultipleBarcodes = useCallback(
    (results: CortexDecoder.CDResult[]) => {
      if (!results || results.length === 0) return;

      const validResults = results.filter((result) => result.barcodeData !== "");
      if (validResults.length === 0) return;

      if (scanMethodType === "EACH_SCAN") {
        // Single Scan: Return first item and stop camera
        const processed = processBarcode(validResults[0].barcodeData, validResults[0].symbology);
        if (scannedSetRef.current.has(processed.data)) return;
        scannedSetRef.current.add(processed.data);
        handleBarcode(processed);
        setIsScannerVisible(false);
      } else {
        // Multi-Scan: Return all (excluding duplicates)
        validResults.forEach((result) => {
          const processed = processBarcode(result.barcodeData, result.symbology);
          if (scannedSetRef.current.has(processed.data)) return;
          scannedSetRef.current.add(processed.data);
          handleBarcode(processed);
        });
      }
    },
    [handleBarcode, processBarcode, scanMethodType, setIsScannerVisible]
  );

  // Sync latest ref to avoid dependency array issues
  useEffect(() => {
    handleMultipleBarcodesRef.current = handleMultipleBarcodes;
  }, [handleMultipleBarcodes]);

  // SDK initialization and camera startup
  useEffect(() => {
    isMountedRef.current = true;

    if (hasInitializedRef.current) return undefined;
    hasInitializedRef.current = true;

    async function initAndStartCamera() {
      // Replace original exception messages with user-friendly fixed text
      const handleInitError = (message: string) => {
        if (!isMountedRef.current) return;
        setInitError(
          new CustomError({ message, link: errorLink, linkText: errorLinkText })
        );
      };

      // Differentiate messages between permission denied and other errors
      const handleCameraError = (e: unknown) => {
        if (!isMountedRef.current) return;
        const message = isCameraPermissionError(e)
          ? "Camera access is not permitted. Please allow camera access in your browser or device settings."
          : "Failed to start camera.";
        setInitError(
          new CustomError({ message, link: errorLink, linkText: errorLinkText })
        );
      };

      let licenseKey: string;
      try {
        licenseKey = await fetchLicenseKey();
      } catch {
        handleInitError("Failed to retrieve the barcode scanner license key.");
        return;
      }

      try {
        await initializeSDK();
      } catch {
        handleInitError("Failed to initialize the barcode scanner.");
        return;
      }

      try {
        await authenticateLicense(licenseKey);
      } catch {
        handleInitError("Barcode scanner license authentication failed.");
        return;
      }

      try {
        await configureDecoder();
      } catch {
        handleInitError("Failed to configure the barcode scanner settings.");
        return;
      }

      if (!isMountedRef.current) return;
      if (!videoRef.current || !canvasRef.current) return;

      try {
        await startCameraWithLock(videoRef.current, canvasRef.current, (results) => {
          if (isMountedRef.current) {
            handleMultipleBarcodesRef.current(results);
          }
        });
      } catch (e) {
        handleCameraError(e);
        return;
      }

      if (!isMountedRef.current) return;

      setIsInit(true);
    }

    initAndStartCamera();

    return () => {
      isMountedRef.current = false;
      stopCameraWithLock();
    };
  }, []);

  // Toggle camera on/off
  useEffect(() => {
    if (!isInit) return;

    async function switchCamera() {
      if (isCameraActive) {
        // Clear scanned set on re-activation
        scannedSetRef.current.clear();

        if (!videoRef.current || !canvasRef.current) return;

        // Treat toggle-time startup failures as transient; do not redirect to error page
        try {
          await startCameraWithLock(
            videoRef.current,
            canvasRef.current,
            (results) => {
              if (isMountedRef.current) {
                handleMultipleBarcodesRef.current(results);
              }
            }
          );
        } catch {
          // Treat toggle startup failures as temporary
        }
      } else {
        await stopCameraWithLock();
      }
    }
    switchCamera();
  }, [isCameraActive, isInit]);

  // Control visibility of camera video elements via CSS classes
  return (
    <div className="scan-camera">
      <div
        className={isCameraActive ? "" : "hide-scan-camera"}
        id="data-capture-view"
        style={{ position: "relative" }}
      >
        <video
          ref={videoRef}
          playsInline
          id="video"
          style={{ width: "100vw", height: "100vh", objectFit: "cover" }}
        />
        <canvas
          ref={canvasRef}
          id="videoCanvas"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}