/**
 * SERVIDOR MULTIUSUARIO — MUSEO LOUVRE VR + SISTEMA SOLAR VR
 * Universidad del Cauca | Proyecto de Grado 2026
 * Lary Betancourt & Laura Sánchez
 *
 * INSTALACIÓN LOCAL:
 *   npm install
 *   node server.js
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Cada socket se une a una "room" de Socket.IO según su entorno
 * ('museo' o 'solar'), y cada evento se manda SOLO dentro de esa room con
 * io.to(entorno)/socket.to(entorno). Además el estado (usuarios, profesor
 * activo, turno de habla) está separado por entorno, así que un profesor en
 * el museo no bloquea que haya otro profesor en el sistema solar, y un
 * turno de habla activo en un entorno no afecta al otro.
 * ─────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.static('public'));

// ─── Estado global, ahora separado por entorno ───────────────────────────────
const ENTORNOS_VALIDOS = ['museo', 'solar'];

function nuevaSala() {
  return { usuarios: {}, profesorId: null, turnoActivo: null };
}

const salas = {
  museo: nuevaSala(),
  solar: nuevaSala()
};

function salaDe(entorno) {
  return salas[entorno] || salas.museo;
}

let mensajesTotal  = 0;
const inicioServer = Date.now();

// ─── Medición de recursos del proceso (WP5) ──────────────────────────────────
// El panel de Render no expone CPU ni memoria en el plan gratuito, pero Node
// sí puede medirse a sí mismo. El muestreo se hace en un intervalo fijo y no
// dentro de los manejadores de petición, para que /estado y pedir_metricas
// lean el mismo valor sin reiniciar la ventana de medición el uno al otro.
//
// Límites asignados por el plan gratuito de Render, usados para expresar el
// consumo como porcentaje de lo realmente disponible:
const LIMITE_CPU_NUCLEOS = 0.15;
const LIMITE_MEMORIA_MB  = 512;

let cpuPorcentajeNucleo = 0;
let _cpuPrevio    = process.cpuUsage();
let _tiempoPrevio = Date.now();

setInterval(() => {
  const ahora = process.cpuUsage();
  const t     = Date.now();
  // process.cpuUsage() devuelve microsegundos de CPU consumidos.
  const usados  = (ahora.user - _cpuPrevio.user) + (ahora.system - _cpuPrevio.system);
  const ventana = (t - _tiempoPrevio) * 1000;
  cpuPorcentajeNucleo = ventana > 0 ? +(100 * usados / ventana).toFixed(2) : 0;
  _cpuPrevio    = ahora;
  _tiempoPrevio = t;
}, 1000);

function recursos() {
  const m = process.memoryUsage();
  const rssMB = +(m.rss / 1048576).toFixed(1);
  return {
    // Porcentaje de un núcleo completo:
    cpuPorcentajeNucleo,
    // Porcentaje sobre los 0.15 núcleos asignados. Este es el que indica
    // saturación real: 100 significa que el proceso agotó su cuota.
    cpuPorcentajeLimite: +(100 * cpuPorcentajeNucleo / (LIMITE_CPU_NUCLEOS * 100)).toFixed(1),
    rssMB,
    memoriaPorcentajeLimite: +(100 * rssMB / LIMITE_MEMORIA_MB).toFixed(1),
    heapUsadoMB:  +(m.heapUsed  / 1048576).toFixed(1),
    heapTotalMB:  +(m.heapTotal / 1048576).toFixed(1),
    limites: { cpuNucleos: LIMITE_CPU_NUCLEOS, memoriaMB: LIMITE_MEMORIA_MB }
  };
}

// ─── Eventos de conexión ──────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // 1 · Registro de usuario
  socket.on('registrar', ({ nombre, rol, avatar, entorno }) => {
    entorno = ENTORNOS_VALIDOS.includes(entorno) ? entorno : 'museo';
    const sala = salaDe(entorno);

    if (rol === 'profesor' && sala.profesorId) {
      rol = 'estudiante';
      socket.emit('rol_cambiado', { rol, motivo: 'Ya existe un profesor activo en este entorno' });
    }

    socket.data.entorno = entorno;
    socket.join(entorno);

    sala.usuarios[socket.id] = {
      id: socket.id,
      nombre: (nombre || 'Usuario').substring(0, 24),
      rol,
      avatar: avatar || null,
      entorno,
      posicion: { x: 0, y: 0, z: 2 },
      rotacion: { x: 0, y: 0, z: 0 },
      manoLevantada: false,
      hablando: false,
      conectadoEn: Date.now()
    };
    if (rol === 'profesor') sala.profesorId = socket.id;

    socket.emit('bienvenida', {
      tuId: socket.id,
      tuRol: rol,
      usuarios: sala.usuarios,
      profesorId: sala.profesorId,
      turnoActivo: sala.turnoActivo
    });
    socket.to(entorno).emit('usuario_entro', sala.usuarios[socket.id]);
    mensajesTotal++;
  });

  // 2 · Posición y rotación de cabeza (hasta 20 veces/segundo por cliente)
  socket.on('mover', ({ posicion, rotacion }) => {
    const entorno = socket.data.entorno;
    const sala = salaDe(entorno);
    if (!sala.usuarios[socket.id]) return;
    sala.usuarios[socket.id].posicion = posicion;
    sala.usuarios[socket.id].rotacion = rotacion;
    socket.to(entorno).emit('usuario_movio', { id: socket.id, posicion, rotacion });
    mensajesTotal++;
  });

  // 3 · Mano levantada / bajada
  socket.on('mano', ({ levantada }) => {
    const entorno = socket.data.entorno;
    const sala = salaDe(entorno);
    if (!sala.usuarios[socket.id]) return;
    sala.usuarios[socket.id].manoLevantada = levantada;
    io.to(entorno).emit('usuario_mano', {
      id: socket.id,
      nombre: sala.usuarios[socket.id].nombre,
      levantada
    });
    mensajesTotal++;
  });

  // 4 · Profesor da / quita turno de habla
  socket.on('dar_turno', ({ idEstudiante }) => {
    const entorno = socket.data.entorno;
    const sala = salaDe(entorno);
    if (socket.id !== sala.profesorId) return;
    if (sala.turnoActivo && sala.usuarios[sala.turnoActivo]) {
      sala.usuarios[sala.turnoActivo].hablando = false;
      io.to(sala.turnoActivo).emit('turno_quitado');
    }
    sala.turnoActivo = idEstudiante || null;
    if (idEstudiante && sala.usuarios[idEstudiante]) {
      sala.usuarios[idEstudiante].hablando      = true;
      sala.usuarios[idEstudiante].manoLevantada = false;
      io.to(idEstudiante).emit('turno_recibido');
      io.to(entorno).emit('turno_actualizado', {
        id: idEstudiante,
        nombre: sala.usuarios[idEstudiante].nombre
      });
    } else {
      io.to(entorno).emit('turno_actualizado', { id: null, nombre: null });
    }
    mensajesTotal++;
  });

  // 5 · Chat de texto
  socket.on('chat', ({ texto }) => {
    const entorno = socket.data.entorno;
    const sala = salaDe(entorno);
    if (!sala.usuarios[socket.id] || !texto.trim()) return;
    io.to(entorno).emit('chat_mensaje', {
      id:     socket.id,
      nombre: sala.usuarios[socket.id].nombre,
      rol:    sala.usuarios[socket.id].rol,
      texto:  texto.trim().substring(0, 200),
      ts:     Date.now()
    });
    mensajesTotal++;
  });

  // 6 · Estado micrófono (Sistema Solar y Museo)
  socket.on('mic_estado', ({ activo }) => {
    const entorno = socket.data.entorno;
    const sala = salaDe(entorno);
    if (!sala.usuarios[socket.id]) return;
    const u = sala.usuarios[socket.id];
    u.hablando = activo;
    socket.to(entorno).emit('usuario_mic', { id: socket.id, activo, rol: u.rol, nombre: u.nombre });
    mensajesTotal++;
  });

  // 7 · WebRTC señalización (audio en tiempo real)
  socket.on('webrtc_offer',   ({ to, offer })     => io.to(to).emit('webrtc_offer',   { from: socket.id, offer }));
  socket.on('webrtc_answer',  ({ to, answer })    => io.to(to).emit('webrtc_answer',  { from: socket.id, answer }));
  socket.on('webrtc_ice',     ({ to, candidate }) => io.to(to).emit('webrtc_ice',     { from: socket.id, candidate }));

  // 8 · Ping para medir latencia (WP5)
  socket.on('ping_lat', (ts) => socket.emit('pong_lat', ts));

  // 9 · Métricas del servidor (WP5) — por entorno, más recursos del proceso.
  socket.on('pedir_metricas', () => {
    const entorno = socket.data.entorno || 'museo';
    const sala = salaDe(entorno);
    socket.emit('metricas', {
      usuariosConectados: Object.keys(sala.usuarios).length,
      mensajesTotal,
      uptimeSegundos: Math.floor((Date.now() - inicioServer) / 1000),
      profesorPresente: !!sala.profesorId,
      turnoActivo: sala.turnoActivo,
      recursos: recursos()
    });
  });

  // 10 · Desconexión
  socket.on('disconnect', () => {
    const entorno = socket.data.entorno;
    const sala = salaDe(entorno);
    if (!sala.usuarios[socket.id]) return;
    const u = sala.usuarios[socket.id];
    if (socket.id === sala.profesorId)  {
      sala.profesorId = null;
      io.to(entorno).emit('profesor_salio');
    }
    if (socket.id === sala.turnoActivo) {
      sala.turnoActivo = null;
      io.to(entorno).emit('turno_actualizado', { id: null, nombre: null });
    }
    delete sala.usuarios[socket.id];
    io.to(entorno).emit('usuario_salio', { id: socket.id, nombre: u.nombre });
  });
});

// ─── Endpoint de salud (para monitoreo y WP5) ────────────────────────────────
app.get('/estado', (_req, res) => res.json({
  estado: 'activo',
  mensajesTotal,
  uptime: Math.floor((Date.now() - inicioServer) / 1000) + 's',
  recursos: recursos(),
  entornos: {
    museo: {
      usuarios: Object.keys(salas.museo.usuarios).length,
      profesor: salas.museo.profesorId ? salas.museo.usuarios[salas.museo.profesorId]?.nombre : null,
      turnoActivo: salas.museo.turnoActivo
    },
    solar: {
      usuarios: Object.keys(salas.solar.usuarios).length,
      profesor: salas.solar.profesorId ? salas.solar.usuarios[salas.solar.profesorId]?.nombre : null,
      turnoActivo: salas.solar.turnoActivo
    }
  }
}));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🏛️🚀 Servidor Louvre + Sistema Solar VR activo en :${PORT}  |  /estado`)
);
