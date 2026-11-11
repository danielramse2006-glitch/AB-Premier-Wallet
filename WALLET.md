# Google Wallet para AB Premier

## Mostrar la tarjeta

Con Node y npm, ejecuta `npm ci` y `npm run dev`. Abre `http://127.0.0.1:5173/wallet-preview.html`. La vista usa el logo de AB Premier, verde oscuro y detalles dorados. El QR de esta pantalla es ilustrativo. La clase real de Wallet usa el mismo logo y color de fondo, con la distribución que define Google.

## Entregarla a un socio

1. El empleado inicia sesión y registra al socio o abre su ficha con el NIP.
2. Pulsa **Generar enlace de Google Wallet** y luego **Compartir enlace**. Puede usar el menú de compartir del teléfono o copiar el enlace para enviarlo.
3. El socio abre el enlace de Google en Android, inicia sesión en su cuenta de Google y guarda la tarjeta.
4. En la siguiente visita, el empleado escanea el QR desde el kiosco, confirma socio, barbero y servicio y registra el corte. El NIP también sirve cuando el cliente no tiene el teléfono.

PostgreSQL guarda una fila privada en `ab_private.wallet_cards` por cada socio, con su identificador de cliente, token revocable e identificador estable del objeto de Wallet. Solicitar el enlace de nuevo reutiliza ese objeto. Este registro representa la emisión y sincronización de la tarjeta. Guardarla o quitarla del celular es una acción en la cuenta de Google.

## Activar la emisión real

- Usa un Supabase configurado con las migraciones del proyecto. Para una base existente, aplica únicamente las migraciones faltantes, en orden. `202609230002_wallet.sql` agrega las tablas y funciones de Wallet. Respáldala antes de aplicar cambios a producción.
- Copia `.env.example` a `.env.local` y configura la URL y la clave publicable del Supabase elegido. Vite usa localhost por defecto. En el celular, el escáner requiere una URL HTTPS y permiso de cámara.
- En Google Cloud habilita Google Wallet API. Crea una cuenta de servicio y dale acceso de Developer en la consola de Google Wallet del emisor. Necesitas acceso de publicación para emitir a todos los clientes.
- En los secretos de Supabase configura `WALLET_ISSUER_ID`, `WALLET_CLASS_SUFFIX` (por ejemplo `familia_ab`), `WALLET_SERVICE_ACCOUNT_JSON` (contenido completo del JSON de Google), `WALLET_LOGO_URL` (PNG público en HTTPS, puede ser el logo publicado de AB Premier), `WALLET_ALLOWED_ORIGINS` (orígenes exactos separados por comas, por ejemplo `http://127.0.0.1:5175`) y `WALLET_SYNC_SECRET` (secreto aleatorio de alta entropía).
- Despliega `wallet` como Supabase Edge Function, usando la configuración de `supabase/config.toml`. La emisión valida el JWT del empleado mediante PostgreSQL. La sincronización autentica por separado al programador con el secreto.
- En Supabase Cron programa cada minuto un POST a `https://<proyecto>.supabase.co/functions/v1/wallet` con JSON `{"action":"sync"}` y encabezados `Content-Type: application/json` y `Authorization: Bearer <WALLET_SYNC_SECRET>`. Guarda el secreto en Supabase Vault y léelo desde el job. Cada ejecución reclama hasta diez tarjetas; una actualización fallida vuelve a quedar disponible cuando expira el bloqueo temporal.
- La primera emisión crea la clase indicada si aún no existe. Si ya existe, configura su logo, nombre y fondo en la consola de Google Wallet, o elige un sufijo nuevo. Para el pase real usa el fondo `#0a2318`, el programa Familia AB y el logo oficial.

## Operación

Las visitas de QR y NIP comparten el historial y la validación existente. Un fallo de Wallet deja la tarjeta pendiente de actualizar y el corte guardado. Si un QR se comparte, el personal puede revocarlo desde la ficha del socio. La nueva emisión actualiza ese pase con un token nuevo. La confirmación de cortes siempre corresponde a una cuenta del personal.

`npm test` verifica el flujo PostgreSQL, incluyendo permisos, duplicados, reintentos, revocación, reemisión y sincronización pendiente.

## Emitir desde Windows sin Docker

Con Node 24 y las dependencias instaladas, la herramienta local usa PostgreSQL
embebido y las migraciones del proyecto. Guarda el registro en
`data/wallet-local`. El operador de esta herramienta es quien ejecuta el comando
en Windows. Para la interfaz web con cuentas de empleados se usa Supabase.

```powershell
node scripts/wallet-local.mjs init
node scripts/wallet-local.mjs register "Socio AB Premier"
$env:AB_WALLET_ISSUER_ID = "<ID de entidad emisora>"
$env:AB_WALLET_KEY_FILE = "C:\ruta\fuera-del-repo\clave-nueva.json"
node scripts/wallet-local.mjs issue <ID numérico del socio>
```

Envía al socio el enlace que imprime el último comando. En modo demo debe
abrirlo con una cuenta autorizada en la consola de Google Wallet. Usa la clase
`familia_ab_local` para distinguir estas tarjetas de las emitidas por la web.

Los comandos `catalogs`, `lookup TOKEN` y `visit TOKEN BARBERO SERVICIO`
permiten consultar el socio y confirmar una visita desde la terminal.

## Publicar la web en Vercel

Importa el repositorio AB-Premier-Wallet como un proyecto nuevo de Vercel.
Configura `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con los valores
del proyecto Supabase de Wallet antes de desplegar. Agrega el origen HTTPS
de Vercel a `WALLET_ALLOWED_ORIGINS` en Supabase. Completa la sección
«Activar la emisión real» para conectar la base, el emisor y la sincronización.
Crea un usuario en Supabase Auth y su perfil administrador siguiendo
`supabase/02_primer_administrador.sql`.
