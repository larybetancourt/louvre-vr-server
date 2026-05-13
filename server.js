/**
 * SERVIDOR MULTIUSUARIO — MUSEO LOUVRE VR
 * Universidad del Cauca | Proyecto de Grado 2026
 * Lary Betancourt & Laura Sánchez
 *
 * INSTALACIÓN LOCAL:
 *   npm install
 *   node server.js
 *
 * EN GLITCH.COM:
 *   1. glitch.com → New Project → Hello Express
 *   2. Reemplazar server.js y package.json con estos archivos
 *   3. Glitch reinicia automáticamente
 *   4. Copiar la URL del proyecto (ej: https://mi-museo-louvre.glitch.me)
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

// ─── Estado global de la sala ─────────────────────────────────────────────────
const sala = {
  usuarios:    {},
  profesorId:  null,
  turnoActivo: null,
};

let mensajesTotal  = 0;
const inicioServer = Date.now();

// ─── Eventos de conexión ──────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // 1 · Registro de usuario
  socket.on('registrar', ({ nombre, rol, avatar }) => {
    if (rol === 'profesor' && sala.profesorId) {
      rol = 'estudiante';
      socket.emit('rol_cambiado', { rol, motivo: 'Ya existe un profesor activo' });
    }
    sala.usuarios[socket.id] = {
      id: socket.id,
      nombre: (nombre || 'Usuario').substring(0, 24),
      rol,
      avatar: avatar || null,
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
    socket.broadcast.emit('usuario_entro', sala.usuarios[socket.id]);
    mensajesTotal++;
  });

  // 2 · Posición y rotación de cabeza (20 veces/segundo por cliente)
  socket.on('mover', ({ posicion, rotacion }) => {
    if (!sala.usuarios[socket.id]) return;
    sala.usuarios[socket.id].posicion = posicion;
    sala.usuarios[socket.id].rotacion = rotacion;
    socket.broadcast.emit('usuario_movio', { id: socket.id, posicion, rotacion });
    mensajesTotal++;
  });

  // 3 · Mano levantada / bajada
  socket.on('mano', ({ levantada }) => {
    if (!sala.usuarios[socket.id]) return;
    sala.usuarios[socket.id].manoLevantada = levantada;
    io.emit('usuario_mano', {
      id: socket.id,
      nombre: sala.usuarios[socket.id].nombre,
      levantada
    });
    mensajesTotal++;
  });

  // 4 · Profesor da / quita turno de habla
  socket.on('dar_turno', ({ idEstudiante }) => {
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
      io.emit('turno_actualizado', {
        id: idEstudiante,
        nombre: sala.usuarios[idEstudiante].nombre
      });
    } else {
      io.emit('turno_actualizado', { id: null, nombre: null });
    }
    mensajesTotal++;
  });

  // 5 · Chat de texto
  socket.on('chat', ({ texto }) => {
    if (!sala.usuarios[socket.id] || !texto.trim()) return;
    io.emit('chat_mensaje', {
      id:     socket.id,
      nombre: sala.usuarios[socket.id].nombre,
      rol:    sala.usuarios[socket.id].rol,
      texto:  texto.trim().substring(0, 200),
      ts:     Date.now()
    });
    mensajesTotal++;
  });

  // 6 · Ping para medir latencia (WP4)
  socket.on('ping_lat', (ts) => socket.emit('pong_lat', ts));

  // 7 · Métricas del servidor (WP4)
  socket.on('pedir_metricas', () => {
    socket.emit('metricas', {
      usuariosConectados: Object.keys(sala.usuarios).length,
      mensajesTotal,
      uptimeSegundos: Math.floor((Date.now() - inicioServer) / 1000),
      profesorPresente: !!sala.profesorId,
      turnoActivo: sala.turnoActivo
    });
  });

  // 8 · Desconexión
  socket.on('disconnect', () => {
    if (!sala.usuarios[socket.id]) return;
    const u = sala.usuarios[socket.id];
    if (socket.id === sala.profesorId)  {
      sala.profesorId = null;
      io.emit('profesor_salio');
    }
    if (socket.id === sala.turnoActivo) {
      sala.turnoActivo = null;
      io.emit('turno_actualizado', { id: null, nombre: null });
    }
    delete sala.usuarios[socket.id];
    io.emit('usuario_salio', { id: socket.id, nombre: u.nombre });
  });
});

// ─── Endpoint de salud (para monitoreo y WP4) ────────────────────────────────
app.get('/estado', (_req, res) => res.json({
  estado: 'activo',
  usuarios: Object.keys(sala.usuarios).length,
  profesor: sala.profesorId ? sala.usuarios[sala.profesorId]?.nombre : null,
  turnoActivo: sala.turnoActivo,
  mensajesTotal,
  uptime: Math.floor((Date.now() - inicioServer) / 1000) + 's'
}));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🏛️  Servidor Louvre VR activo en :${PORT}  |  /estado para métricas`)
);
