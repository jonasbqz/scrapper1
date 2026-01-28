# Frontend Integration Guide - Lector Monline API

## Base Configuration

```
API_URL = http://localhost:8085
```

**Headers para todas las peticiones:**
```typescript
const headers = {
  'Content-Type': 'application/json',
};
```

**Headers para peticiones autenticadas:**
```typescript
const authHeaders = {
  'Content-Type': 'application/json',
  'Cookie': sessionCookie, // O usar credentials: 'include'
};
```

---

## Sistema de Autenticacion (Better-Auth)

La API usa **Better-Auth** para manejar la autenticacion. Las sesiones se almacenan en cookies y duran **7 dias**.

### Flujo de Autenticacion

```
1. Usuario se registra/inicia sesion -> Recibe cookie de sesion
2. Cookie se envia automaticamente en cada peticion (credentials: 'include')
3. El backend valida la sesion y adjunta info del usuario
4. Para operaciones de usuario se requiere crear un PERFIL
```

### Configuracion de Fetch (Importante)

```typescript
// CRITICO: Siempre incluir credentials para enviar cookies
const fetchWithAuth = (url: string, options: RequestInit = {}) => {
  return fetch(url, {
    ...options,
    credentials: 'include', // Envia y recibe cookies automaticamente
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
};
```

### Configuracion con Axios

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:8085',
  withCredentials: true, // CRITICO: Habilitar cookies
  headers: {
    'Content-Type': 'application/json',
  },
});
```

---

## Endpoints de Autenticacion

### Registro de Usuario

```typescript
// POST /auth/sign-up/email
const register = async (email: string, password: string, name: string) => {
  const response = await fetch('http://localhost:8085/auth/sign-up/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }

  return response.json();
  // Respuesta: { user: { id, email, name }, session: { token, expiresAt } }
};
```

### Inicio de Sesion

```typescript
// POST /auth/sign-in/email
const login = async (email: string, password: string) => {
  const response = await fetch('http://localhost:8085/auth/sign-in/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }

  return response.json();
  // Respuesta: { user: { id, email, name }, session: { token, expiresAt } }
};
```

### Cerrar Sesion

```typescript
// POST /auth/sign-out
const logout = async () => {
  const response = await fetch('http://localhost:8085/auth/sign-out', {
    method: 'POST',
    credentials: 'include',
  });

  return response.ok;
};
```

### Obtener Sesion Actual

```typescript
// GET /api/auth/session
const getSession = async () => {
  const response = await fetch('http://localhost:8085/api/auth/session', {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    return null; // No hay sesion activa
  }

  return response.json();
  // Respuesta: { user: { id, email, name }, profileId?: string }
};
```

### Obtener Usuario Actual

```typescript
// GET /api/me
const getCurrentUser = async () => {
  const response = await fetch('http://localhost:8085/api/me', {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('No autenticado');
  }

  return response.json();
};
```

---

## Gestion de Perfiles

**IMPORTANTE:** Muchos endpoints requieren que el usuario tenga un perfil creado. Sin perfil, los endpoints de bookmarks y reading-history fallaran con 401.

### Crear Perfil (Requerido despues del registro)

```typescript
// POST /api/profile
interface CreateProfileDto {
  username: string;        // 3-50 caracteres, unico
  visibleName?: string;    // Max 100 caracteres
  bio?: string;            // Max 500 caracteres
  avatarUrl?: string;      // URL de imagen
  language?: 'en' | 'es' | 'pt'; // Default: 'es'
}

const createProfile = async (data: CreateProfileDto) => {
  const response = await fetch('http://localhost:8085/api/profile', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }

  return response.json();
};
```

### Obtener Mi Perfil

```typescript
// GET /api/profile/me
const getMyProfile = async () => {
  const response = await fetch('http://localhost:8085/api/profile/me', {
    method: 'GET',
    credentials: 'include',
  });

  return response.json();
};
```

### Actualizar Perfil

```typescript
// PUT /api/profile/me
interface UpdateProfileDto {
  username?: string;
  visibleName?: string;
  bio?: string;
  avatarUrl?: string;
  language?: 'en' | 'es' | 'pt';
  isAdultContent?: boolean;
}

const updateProfile = async (data: UpdateProfileDto) => {
  const response = await fetch('http://localhost:8085/api/profile/me', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  return response.json();
};
```

### Buscar Perfil Publico

```typescript
// GET /api/profile/username/:username (No requiere auth)
const getPublicProfile = async (username: string) => {
  const response = await fetch(`http://localhost:8085/api/profile/username/${username}`);
  return response.json();
};
```

---

## Comics (Endpoints Publicos)

### Listar Comics con Filtros

```typescript
// GET /api/comics
interface ComicFilters {
  search?: string;           // Buscar por titulo
  type?: 'manga' | 'manhwa' | 'manhua';
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genres?: string;           // IDs separados por coma: "1,2,3"
  nsfw?: boolean;
  page?: number;             // Default: 1
  limit?: number;            // Default: 20
}

const getComics = async (filters: ComicFilters = {}) => {
  const params = new URLSearchParams();

  if (filters.search) params.append('search', filters.search);
  if (filters.type) params.append('type', filters.type);
  if (filters.status) params.append('status', filters.status);
  if (filters.genres) params.append('genres', filters.genres);
  if (filters.nsfw !== undefined) params.append('nsfw', String(filters.nsfw));
  if (filters.page) params.append('page', String(filters.page));
  if (filters.limit) params.append('limit', String(filters.limit));

  const response = await fetch(`http://localhost:8085/api/comics?${params}`);
  return response.json();

  // Respuesta:
  // {
  //   data: Comic[],
  //   pagination: { page, limit, total, totalPages }
  // }
};
```

### Obtener Comics Trending

```typescript
// GET /api/comics/trending?limit=10
const getTrendingComics = async (limit = 10) => {
  const response = await fetch(`http://localhost:8085/api/comics/trending?limit=${limit}`);
  return response.json();
};
```

### Obtener Comics Recientes

```typescript
// GET /api/comics/recent?limit=10
const getRecentComics = async (limit = 10) => {
  const response = await fetch(`http://localhost:8085/api/comics/recent?limit=${limit}`);
  return response.json();
};
```

### Obtener Generos

```typescript
// GET /api/comics/genres
const getGenres = async () => {
  const response = await fetch('http://localhost:8085/api/comics/genres');
  return response.json();
  // Respuesta: [{ id, name, slug }]
};
```

### Obtener Comic por ID o Slug

```typescript
// GET /api/comics/:id
const getComicById = async (id: number) => {
  const response = await fetch(`http://localhost:8085/api/comics/${id}`);
  return response.json();
};

// GET /api/comics/slug/:slug
const getComicBySlug = async (slug: string) => {
  const response = await fetch(`http://localhost:8085/api/comics/slug/${slug}`);
  return response.json();
};
```

### Estructura de Comic

```typescript
interface Comic {
  id: number;
  title: string;
  titleAlternative: string | null;
  slug: string;
  author: string | null;
  artist: string | null;
  description: string | null;
  type: 'manga' | 'manhwa' | 'manhua';
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  coverImage: string | null;
  views: number;
  likes: number;
  followers: number;
  isNsfw: boolean;
  copyrighted: boolean;
  genres: Genre[];
  comicScans: ComicScan[];
  createdAt: string;
  updatedAt: string;
}
```

---

## Capitulos (Endpoints Publicos)

### Obtener Capitulo con Navegacion

```typescript
// GET /api/chapters/:id
const getChapter = async (chapterId: number) => {
  const response = await fetch(`http://localhost:8085/api/chapters/${chapterId}`);
  return response.json();

  // Respuesta:
  // {
  //   current: Chapter,
  //   prev: Chapter | null,
  //   next: Chapter | null
  // }
};
```

### Obtener Paginas del Capitulo

```typescript
// GET /api/chapters/:id/pages
const getChapterPages = async (chapterId: number) => {
  const response = await fetch(`http://localhost:8085/api/chapters/${chapterId}/pages`);
  return response.json();
  // Respuesta: { urlPages: string[] }
};
```

### Obtener Capitulos de un Comic

```typescript
// GET /api/chapters/comic-scan/:comicScanId
const getChaptersByComicScan = async (comicScanId: number) => {
  const response = await fetch(`http://localhost:8085/api/chapters/comic-scan/${comicScanId}`);
  return response.json();
};
```

### Estructura de Capitulo

```typescript
interface Chapter {
  id: number;
  comicScanId: number;
  chapterNumber: number; // Puede ser decimal: 1, 1.5, 2
  title: string | null;
  slug: string;
  releaseDate: string;
  urlPages: string[];
  views: number;
  copyrighted: boolean;
  comicScan?: ComicScan;
}
```

---

## Bookmarks (Requiere Auth + Perfil)

### Crear/Actualizar Bookmark

```typescript
// POST /api/bookmarks
interface CreateBookmarkDto {
  comicId: number;
  status?: 'reading' | 'completed' | 'dropped' | 'plan_to_read';
  isFavorite?: boolean;
}

const createBookmark = async (data: CreateBookmarkDto) => {
  const response = await fetch('http://localhost:8085/api/bookmarks', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  return response.json();
};
```

### Obtener Todos los Bookmarks

```typescript
// GET /api/bookmarks
const getBookmarks = async () => {
  const response = await fetch('http://localhost:8085/api/bookmarks', {
    credentials: 'include',
  });
  return response.json();
};
```

### Obtener Favoritos

```typescript
// GET /api/bookmarks/favorites
const getFavorites = async () => {
  const response = await fetch('http://localhost:8085/api/bookmarks/favorites', {
    credentials: 'include',
  });
  return response.json();
};
```

### Obtener por Status

```typescript
// GET /api/bookmarks/status/:status
type BookmarkStatus = 'reading' | 'completed' | 'dropped' | 'plan_to_read';

const getBookmarksByStatus = async (status: BookmarkStatus) => {
  const response = await fetch(`http://localhost:8085/api/bookmarks/status/${status}`, {
    credentials: 'include',
  });
  return response.json();
};
```

### Obtener Bookmark de un Comic

```typescript
// GET /api/bookmarks/:comicId
const getBookmark = async (comicId: number) => {
  const response = await fetch(`http://localhost:8085/api/bookmarks/${comicId}`, {
    credentials: 'include',
  });

  if (response.status === 404) return null;
  return response.json();
};
```

### Actualizar Bookmark

```typescript
// PUT /api/bookmarks/:comicId
const updateBookmark = async (comicId: number, data: Partial<CreateBookmarkDto>) => {
  const response = await fetch(`http://localhost:8085/api/bookmarks/${comicId}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  return response.json();
};
```

### Eliminar Bookmark

```typescript
// DELETE /api/bookmarks/:comicId
const deleteBookmark = async (comicId: number) => {
  const response = await fetch(`http://localhost:8085/api/bookmarks/${comicId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  return response.ok;
};
```

---

## Historial de Lectura (Requiere Auth + Perfil)

### Registrar Progreso de Lectura

```typescript
// POST /api/reading-history
interface RecordReadingDto {
  comicId: number;
  chapterId: number;
  progressPercentage?: number; // 0-100
}

const recordReading = async (data: RecordReadingDto) => {
  const response = await fetch('http://localhost:8085/api/reading-history', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  return response.json();
};
```

### Obtener Historial Completo

```typescript
// GET /api/reading-history
const getReadingHistory = async () => {
  const response = await fetch('http://localhost:8085/api/reading-history', {
    credentials: 'include',
  });
  return response.json();
};
```

### Obtener Historial Reciente

```typescript
// GET /api/reading-history/recent?limit=10
const getRecentHistory = async (limit = 10) => {
  const response = await fetch(`http://localhost:8085/api/reading-history/recent?limit=${limit}`, {
    credentials: 'include',
  });
  return response.json();
};
```

### Obtener Ultimo Capitulo Leido

```typescript
// GET /api/reading-history/comic/:comicId/last
const getLastReadChapter = async (comicId: number) => {
  const response = await fetch(`http://localhost:8085/api/reading-history/comic/${comicId}/last`, {
    credentials: 'include',
  });

  if (response.status === 404) return null;
  return response.json();
};
```

### Eliminar Entrada del Historial

```typescript
// DELETE /api/reading-history/:id
const deleteHistoryEntry = async (historyId: string) => {
  const response = await fetch(`http://localhost:8085/api/reading-history/${historyId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  return response.ok;
};
```

---

## Formato de Respuestas

### Respuesta Exitosa

Todas las respuestas exitosas siguen este formato:

```typescript
interface ApiResponse<T> {
  data: T;
  timestamp: string; // ISO 8601
}

// Ejemplo:
// {
//   "data": { ... },
//   "timestamp": "2024-01-15T12:00:00.000Z"
// }
```

### Respuesta con Paginacion

```typescript
interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### Respuesta de Error

```typescript
interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
}

// Ejemplo:
// {
//   "statusCode": 401,
//   "error": "Unauthorized",
//   "message": "No session found",
//   "timestamp": "2024-01-15T12:00:00.000Z"
// }
```

---

## Ejemplo Completo: Hook de React

```typescript
// hooks/useAuth.ts
import { useState, useEffect, createContext, useContext } from 'react';

interface User {
  id: string;
  email: string;
  name: string;
}

interface Profile {
  id: string;
  username: string;
  visibleName?: string;
  avatarUrl?: string;
}

interface AuthState {
  user: User | null;
  profile: Profile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  hasProfile: boolean;
}

const API_URL = 'http://localhost:8085';

export const useAuth = () => {
  const [state, setState] = useState<AuthState>({
    user: null,
    profile: null,
    isLoading: true,
    isAuthenticated: false,
    hasProfile: false,
  });

  // Verificar sesion al cargar
  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/session`, {
        credentials: 'include',
      });

      if (!res.ok) {
        setState(s => ({ ...s, isLoading: false }));
        return;
      }

      const { data } = await res.json();

      setState({
        user: data.user,
        profile: null,
        isLoading: false,
        isAuthenticated: true,
        hasProfile: !!data.profileId,
      });

      // Si tiene perfil, cargarlo
      if (data.profileId) {
        loadProfile();
      }
    } catch {
      setState(s => ({ ...s, isLoading: false }));
    }
  };

  const loadProfile = async () => {
    try {
      const res = await fetch(`${API_URL}/api/profile/me`, {
        credentials: 'include',
      });

      if (res.ok) {
        const { data } = await res.json();
        setState(s => ({ ...s, profile: data, hasProfile: true }));
      }
    } catch {
      // Profile no disponible
    }
  };

  const login = async (email: string, password: string) => {
    const res = await fetch(`${API_URL}/auth/sign-in/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Error al iniciar sesion');
    }

    await checkSession();
    return true;
  };

  const register = async (email: string, password: string, name: string) => {
    const res = await fetch(`${API_URL}/auth/sign-up/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Error al registrarse');
    }

    await checkSession();
    return true;
  };

  const logout = async () => {
    await fetch(`${API_URL}/auth/sign-out`, {
      method: 'POST',
      credentials: 'include',
    });

    setState({
      user: null,
      profile: null,
      isLoading: false,
      isAuthenticated: false,
      hasProfile: false,
    });
  };

  const createProfile = async (data: { username: string; visibleName?: string }) => {
    const res = await fetch(`${API_URL}/api/profile`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Error al crear perfil');
    }

    const { data: profile } = await res.json();
    setState(s => ({ ...s, profile, hasProfile: true }));
    return profile;
  };

  return {
    ...state,
    login,
    register,
    logout,
    createProfile,
    refreshSession: checkSession,
  };
};
```

---

## Ejemplo: Servicio de API

```typescript
// services/api.ts
const API_URL = 'http://localhost:8085';

class ApiService {
  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Error en la peticion');
    }

    return data.data;
  }

  // Comics
  async getComics(filters?: ComicFilters) {
    const params = new URLSearchParams(filters as any).toString();
    return this.fetch(`/api/comics${params ? `?${params}` : ''}`);
  }

  async getComic(idOrSlug: number | string) {
    const endpoint = typeof idOrSlug === 'number'
      ? `/api/comics/${idOrSlug}`
      : `/api/comics/slug/${idOrSlug}`;
    return this.fetch(endpoint);
  }

  async getTrendingComics(limit = 10) {
    return this.fetch(`/api/comics/trending?limit=${limit}`);
  }

  async getRecentComics(limit = 10) {
    return this.fetch(`/api/comics/recent?limit=${limit}`);
  }

  async getGenres() {
    return this.fetch('/api/comics/genres');
  }

  // Chapters
  async getChapter(id: number) {
    return this.fetch(`/api/chapters/${id}`);
  }

  async getChapterPages(id: number) {
    return this.fetch(`/api/chapters/${id}/pages`);
  }

  // Bookmarks
  async getBookmarks() {
    return this.fetch('/api/bookmarks');
  }

  async addBookmark(comicId: number, status?: string) {
    return this.fetch('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify({ comicId, status }),
    });
  }

  async removeBookmark(comicId: number) {
    return this.fetch(`/api/bookmarks/${comicId}`, {
      method: 'DELETE',
    });
  }

  // Reading History
  async recordReading(comicId: number, chapterId: number, progress?: number) {
    return this.fetch('/api/reading-history', {
      method: 'POST',
      body: JSON.stringify({
        comicId,
        chapterId,
        progressPercentage: progress
      }),
    });
  }

  async getRecentHistory(limit = 10) {
    return this.fetch(`/api/reading-history/recent?limit=${limit}`);
  }

  async getLastRead(comicId: number) {
    try {
      return await this.fetch(`/api/reading-history/comic/${comicId}/last`);
    } catch {
      return null;
    }
  }
}

export const api = new ApiService();
```

---

## Flujo Recomendado para el Frontend

```
1. Al cargar la app:
   - Llamar GET /api/auth/session
   - Si hay sesion: cargar perfil (GET /api/profile/me)
   - Si no hay perfil: mostrar formulario de crear perfil

2. Pagina de inicio:
   - GET /api/comics/trending
   - GET /api/comics/recent
   - GET /api/comics/genres (para filtros)

3. Busqueda/Catalogo:
   - GET /api/comics con filtros

4. Detalle de comic:
   - GET /api/comics/slug/:slug
   - Si autenticado: GET /api/bookmarks/:comicId
   - Si autenticado: GET /api/reading-history/comic/:comicId/last

5. Lector de capitulo:
   - GET /api/chapters/:id (incluye prev/next)
   - GET /api/chapters/:id/pages
   - Al leer: POST /api/reading-history (registrar progreso)

6. Biblioteca del usuario:
   - GET /api/bookmarks
   - GET /api/bookmarks/favorites
   - GET /api/reading-history/recent

7. Perfil de usuario:
   - GET /api/profile/me
   - PUT /api/profile/me (actualizar)
```

---

## Documentacion Swagger

La documentacion interactiva de la API esta disponible en:

```
http://localhost:8085/docs
```

Ahi puedes probar todos los endpoints directamente desde el navegador.

---

## Notas Importantes

1. **CORS**: El frontend debe correr en un origen permitido (configurado en `CORS_ORIGIN` del backend).

2. **Cookies**: Las cookies de sesion son HttpOnly, no puedes accederlas desde JavaScript. Usa `credentials: 'include'` siempre.

3. **Perfil Obligatorio**: Para usar bookmarks y reading-history, el usuario DEBE crear un perfil primero.

4. **Sesiones**: Las sesiones expiran en 7 dias. El backend renueva automaticamente si se usa dentro del periodo de actualizacion (1 dia).

5. **Rate Limiting**: No hay rate limiting implementado actualmente, pero evita hacer peticiones excesivas.

6. **Manejo de Errores**: Siempre verifica `response.ok` y maneja los errores apropiadamente.
