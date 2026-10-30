"use client";

import { Chess, type Square } from "chess.js";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CHESS_CAPTURED_DELAY_MS, CHESS_CAPTURED_MS, SLIDE_MS } from "@/lib/animation";

type Props = {
  fen: string;
  selected: Square | null;
  legalTargets: Square[];
  lastMove: [Square, Square] | null;
  onSquareClick: (square: Square) => void;
  /** Called when WebGL cannot start, so the page can fall back to the 2D board. */
  onUnavailable: () => void;
};

type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

const FILES = "abcdefgh";
const PIECE_FILES: Record<PieceType, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
// Every model has the same base width, so one scale keeps the set in proportion.
const PIECE_BASE_WIDTH = 0.72;

const COLORS = {
  light: "#e9f0df",
  dark: "#659477",
  lastLight: "#dce995",
  lastDark: "#89a854",
  frame: "#284839",
  label: "#cfe0d2",
  white: "#ece4cf",
  black: "#1f3b30",
  selected: "#f4d65d",
  capture: "#f2d657",
  dot: "#193b2d",
};

/** Square name -> world position of its centre (white at the near side, +z). */
function squareToPosition(square: Square): THREE.Vector3 {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return new THREE.Vector3(file - 3.5, 0, 4.5 - rank);
}

let templatesPromise: Promise<Record<PieceType, THREE.Object3D>> | null = null;

/** Load the six CC0 models once (public/models/chess) and normalise them to stand on y = 0. */
function loadTemplates() {
  templatesPromise ??= (async () => {
    const loader = new GLTFLoader();
    const entries = await Promise.all((Object.keys(PIECE_FILES) as PieceType[]).map(async (type) => {
      const gltf = await loader.loadAsync(`/models/chess/${PIECE_FILES[type]}.glb`);
      const model = gltf.scene;
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      model.scale.multiplyScalar(PIECE_BASE_WIDTH / Math.min(size.x, size.z));
      const box = new THREE.Box3().setFromObject(model);
      model.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
      const holder = new THREE.Group();
      holder.add(model);
      return [type, holder] as const;
    }));
    const templates = {} as Record<PieceType, THREE.Object3D>;
    for (const [type, holder] of entries) templates[type] = holder;
    return templates;
  })();
  return templatesPromise;
}

function makeLabel(text: string): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = COLORS.label;
  context.font = "600 40px 'Space Grotesk', 'Segoe UI', sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  label.rotation.x = -Math.PI / 2;
  return label;
}

export default function ChessBoard3D({ fen, selected, legalTargets, lastMove, onSquareClick, onUnavailable }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    tiles: Map<Square, THREE.Mesh>;
    pieces: THREE.Group;
    markers: THREE.Group;
    requestRender: () => void;
    animate: (object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, arc: number) => void;
    shrinkAway: (object: THREE.Object3D) => void;
    templates: Record<PieceType, THREE.Object3D> | null;
    materials: { white: THREE.Material; black: THREE.Material };
  } | null>(null);
  const clickRef = useRef(onSquareClick);
  const unavailableRef = useRef(onUnavailable);
  const lastMoveRef = useRef(lastMove);
  const previousFenRef = useRef<string | null>(null);
  const [templatesReady, setTemplatesReady] = useState(false);

  useEffect(() => {
    clickRef.current = onSquareClick;
    unavailableRef.current = onUnavailable;
    lastMoveRef.current = lastMove;
  });

  // Build the renderer, camera, lights and board once.
  useEffect(() => {
    const container = containerRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      // In the desktop app the GPU is chosen in electron/main.js; this hint helps in browsers that honour it.
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      unavailableRef.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", "3D chess board. Use the 2D view for keyboard play.");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    scene.add(new THREE.HemisphereLight("#ffffff", "#6f8c78", 1.25));
    const sun = new THREE.DirectionalLight("#fffaf0", 2.7);
    sun.position.set(4, 11, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item; };

    // Frame, squares and coordinate labels.
    const frame = new THREE.Mesh(track(new THREE.BoxGeometry(8.9, 0.34, 8.9)), track(new THREE.MeshStandardMaterial({ color: COLORS.frame, roughness: 0.7 })));
    frame.position.y = -0.2;
    frame.receiveShadow = true;
    scene.add(frame);
    const tileGeometry = track(new THREE.BoxGeometry(1, 0.1, 1));
    const tiles = new Map<Square, THREE.Mesh>();
    for (let file = 0; file < 8; file += 1) {
      for (let rank = 1; rank <= 8; rank += 1) {
        const square = `${FILES[file]}${rank}` as Square;
        const dark = (file + rank) % 2 === 0;
        const tile = new THREE.Mesh(tileGeometry, track(new THREE.MeshStandardMaterial({ color: dark ? COLORS.dark : COLORS.light, roughness: 0.85 })));
        tile.position.copy(squareToPosition(square)).setY(-0.05);
        tile.receiveShadow = true;
        tile.userData = { square, dark };
        tiles.set(square, tile);
        scene.add(tile);
      }
    }
    for (let index = 0; index < 8; index += 1) {
      const file = makeLabel(FILES[index]);
      file.position.set(index - 3.5, -0.02, 4.22);
      const rank = makeLabel(String(index + 1));
      rank.position.set(-4.22, -0.02, 3.5 - index);
      scene.add(file, rank);
      for (const label of [file, rank]) {
        track(label.geometry);
        track(label.material as THREE.MeshBasicMaterial);
        track((label.material as THREE.MeshBasicMaterial).map!);
      }
    }

    const pieces = new THREE.Group();
    const markers = new THREE.Group();
    scene.add(pieces, markers);
    const materials = {
      white: track(new THREE.MeshStandardMaterial({ color: COLORS.white, roughness: 0.42 })),
      black: track(new THREE.MeshStandardMaterial({ color: COLORS.black, roughness: 0.42 })),
    };

    // The camera is fixed. Render only when something changes: a resize, an animation, or new props.
    let frameId = 0;
    const animations = new Set<(now: number) => boolean>();
    const requestRender = () => {
      if (frameId) return;
      frameId = requestAnimationFrame((now) => {
        frameId = 0;
        let busy = false;
        for (const step of animations) {
          if (step(now)) busy = true;
          else animations.delete(step);
        }
        renderer.render(scene, camera);
        if (busy) requestRender();
      });
    };

    const animate = (object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, arc: number) => {
      const start = performance.now();
      object.position.copy(from);
      animations.add((now) => {
        const t = Math.min(1, (now - start) / SLIDE_MS);
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        object.position.lerpVectors(from, to, eased);
        object.position.y = Math.sin(Math.PI * eased) * arc;
        return t < 1;
      });
      requestRender();
    };

    // A captured piece shrinks away as the attacker lands, then is removed.
    const shrinkAway = (object: THREE.Object3D) => {
      const start = performance.now();
      animations.add((now) => {
        const t = Math.min(1, Math.max(0, (now - start - CHESS_CAPTURED_DELAY_MS) / CHESS_CAPTURED_MS));
        object.scale.setScalar(Math.max(0.001, 1 - t * t));
        if (t < 1) return true;
        object.removeFromParent();
        return false;
      });
      requestRender();
    };

    // Fit the whole board, including the back rank's tall pieces, into the square view.
    const fitCamera = () => {
      const { clientWidth: width, clientHeight: height } = container;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      // Camera tilt from straight above, in radians: enough to show depth, flat enough to fill the view.
      const direction = new THREE.Vector3(0, Math.cos(0.56), Math.sin(0.56));
      const target = new THREE.Vector3(0, 0, 0.25);
      const corners = [-4.45, 4.45].flatMap((x) => [-4.45, 4.45].flatMap((z) => [0, 1.5].map((y) => new THREE.Vector3(x, y, z))));
      let low = 4;
      let high = 40;
      for (let step = 0; step < 24; step += 1) {
        const distance = (low + high) / 2;
        camera.position.copy(target).addScaledVector(direction, distance);
        camera.lookAt(target);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const fits = corners.every((corner) => {
          const point = corner.clone().project(camera);
          return Math.abs(point.x) <= 0.96 && Math.abs(point.y) <= 0.96;
        });
        if (fits) high = distance;
        else low = distance;
      }
      camera.position.copy(target).addScaledVector(direction, high);
      camera.lookAt(target);
      requestRender();
    };
    const resizeObserver = new ResizeObserver(fitCamera);
    resizeObserver.observe(container);
    fitCamera();

    // Clicking a square or piece selects it.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const squareAt = (event: MouseEvent): Square | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...pieces.children, ...tiles.values()], true)[0];
      let object: THREE.Object3D | null = hit?.object ?? null;
      while (object && !object.userData.square) object = object.parent;
      return (object?.userData.square as Square | undefined) ?? null;
    };
    const onClick = (event: MouseEvent) => {
      const square = squareAt(event);
      if (square) clickRef.current(square);
    };
    const onPointerMove = (event: PointerEvent) => {
      renderer.domElement.style.cursor = squareAt(event) ? "pointer" : "default";
    };
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("pointermove", onPointerMove);

    sceneRef.current = { tiles, pieces, markers, requestRender, animate, shrinkAway, templates: null, materials };
    let cancelled = false;
    loadTemplates()
      .then((templates) => {
        if (cancelled || !sceneRef.current) return;
        sceneRef.current.templates = templates;
        setTemplatesReady(true);
      })
      .catch(() => {
        if (!cancelled) unavailableRef.current();
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      for (const item of disposables) item.dispose();
      for (const marker of markers.children) disposeMesh(marker);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
    };
  }, []);

  // Place pieces whenever the position changes, sliding the piece that just moved.
  useEffect(() => {
    const view = sceneRef.current;
    if (!view?.templates) return;
    const previousFen = previousFenRef.current;
    previousFenRef.current = fen;
    view.pieces.clear();
    const templates = view.templates;
    const place = (type: PieceType, color: "w" | "b", square: Square) => {
      const piece = templates[type].clone(true);
      const material = color === "w" ? view.materials.white : view.materials.black;
      piece.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          (node as THREE.Mesh).material = material;
          node.castShadow = true;
        }
      });
      piece.userData = { square };
      piece.position.copy(squareToPosition(square));
      // Knights show their profile: those on the queenside face right, kingside face left.
      if (type === "n") piece.rotation.y = FILES.indexOf(square[0]) < 4 ? Math.PI / 2 : -Math.PI / 2;
      else if (color === "b") piece.rotation.y = Math.PI;
      view.pieces.add(piece);
      return piece;
    };
    const board = new Chess(fen).board();
    let moved: THREE.Object3D | null = null;
    const lastMoved = lastMoveRef.current;
    const move: [Square, Square] | null = lastMoved ? [lastMoved[0], lastMoved[1]] : null;
    const isNewMove = Boolean(move && previousFen && previousFen !== fen);
    for (const row of board) {
      for (const cell of row) {
        if (!cell) continue;
        const piece = place(cell.type as PieceType, cell.color, cell.square);
        if (isNewMove && move && cell.square === move[1]) moved = piece;
      }
    }
    if (moved && move && previousFen) {
      // The piece the move took, if any: on the target square, or beside it for en passant.
      const before = new Chess(previousFen);
      let capturedSquare: Square = move[1];
      let captured = before.get(capturedSquare);
      if (!captured && before.get(move[0])?.type === "p" && move[0][0] !== move[1][0]) {
        capturedSquare = `${move[1][0]}${move[0][1]}` as Square;
        captured = before.get(capturedSquare);
      }
      if (captured) view.shrinkAway(place(captured.type as PieceType, captured.color, capturedSquare));
      const isKnight = new Chess(fen).get(move[1])?.type === "n";
      view.animate(moved, squareToPosition(move[0]), squareToPosition(move[1]), isKnight ? 0.9 : 0.25);
    } else {
      view.requestRender();
    }
  }, [fen, templatesReady]);

  // Selection, legal-move markers and last-move highlight.
  useEffect(() => {
    const view = sceneRef.current;
    if (!view) return;
    for (const [square, tile] of view.tiles) {
      const isLast = lastMove?.includes(square) ?? false;
      const dark = tile.userData.dark as boolean;
      (tile.material as THREE.MeshStandardMaterial).color.set(isLast ? (dark ? COLORS.lastDark : COLORS.lastLight) : (dark ? COLORS.dark : COLORS.light));
    }
    for (const marker of [...view.markers.children]) {
      disposeMesh(marker);
      view.markers.remove(marker);
    }
    const occupied = new Set(new Chess(fen).board().flat().filter(Boolean).map((cell) => cell!.square));
    if (selected) {
      const outline = new THREE.Shape();
      outline.moveTo(-0.5, -0.5).lineTo(0.5, -0.5).lineTo(0.5, 0.5).lineTo(-0.5, 0.5).lineTo(-0.5, -0.5);
      const hole = new THREE.Path();
      hole.moveTo(-0.43, -0.43).lineTo(-0.43, 0.43).lineTo(0.43, 0.43).lineTo(0.43, -0.43).lineTo(-0.43, -0.43);
      outline.holes.push(hole);
      const ring = new THREE.Mesh(new THREE.ShapeGeometry(outline), new THREE.MeshBasicMaterial({ color: COLORS.selected }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(squareToPosition(selected)).setY(0.004);
      view.markers.add(ring);
    }
    for (const target of legalTargets) {
      const capture = occupied.has(target);
      const marker = capture
        ? new THREE.Mesh(new THREE.RingGeometry(0.4, 0.47, 40), new THREE.MeshBasicMaterial({ color: COLORS.capture }))
        : new THREE.Mesh(new THREE.CircleGeometry(0.13, 32), new THREE.MeshBasicMaterial({ color: COLORS.dot, transparent: true, opacity: 0.45 }));
      marker.rotation.x = -Math.PI / 2;
      marker.position.copy(squareToPosition(target)).setY(0.004);
      view.markers.add(marker);
    }
    view.requestRender();
  }, [fen, selected, legalTargets, lastMove, templatesReady]);

  return <div ref={containerRef} className="board3d" />;
}

function disposeMesh(object: THREE.Object3D) {
  const mesh = object as THREE.Mesh;
  mesh.geometry?.dispose();
  (mesh.material as THREE.Material | undefined)?.dispose();
}
