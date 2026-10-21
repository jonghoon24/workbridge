import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SECRET_KEY
);

/**
 * Uploads to the `workbridge` bucket at `<folder>/<filename>` and returns the public URL.
 * `folder` defaults to `profiles`, the only folder the pre-existing profile upload uses.
 */
export async function uploadToSupabase(
  buffer: Buffer,
  mimetype: string,
  filename: string,
  folder = 'profiles',
): Promise<string> {
  const { data, error } = await supabase.storage
    .from('workbridge')
    .upload(`${folder}/${filename}`, buffer, {
      contentType: mimetype,
      upsert: true,
    });

  if (error) throw error;

  const { data: { publicUrl } } = supabase.storage
    .from('workbridge')
    .getPublicUrl(data.path);

  return publicUrl;
}
