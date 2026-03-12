import multer from 'multer';
import { createClient } from '@supabase/supabase-js';

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
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

export async function uploadToSupabase(buffer, mimetype, filename) {
  const { data, error } = await supabase.storage
    .from('workbridge')
    .upload(`profiles/${filename}`, buffer, {
      contentType: mimetype,
      upsert: true,
    });

  if (error) throw error;

  const { data: { publicUrl } } = supabase.storage
    .from('workbridge')
    .getPublicUrl(data.path);

  return publicUrl;
}
