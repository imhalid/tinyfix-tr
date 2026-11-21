import { APP_NAME } from "../brand";
import { Button, Dialog } from "../ui";

export interface PrivacyDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PrivacyDialog(props: PrivacyDialogProps) {
  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title="Gizlilik ve internetsiz çalışma"
      description={`${APP_NAME} içinde yazdığınız hiçbir metin cihazınızdan çıkmaz.`}
      footer={<Button type="submit">Tamam</Button>}
    >
      <div class="privacy-copy">
        <ul>
          <li>
            <strong>Sunucu yok:</strong> Otomatik düzeltme sözlüğü, bağlam modeli ve kuralları
            tarayıcınızda, ayrı bir Web Worker içinde çalışır.
          </li>
          <li>
            <strong>Belgeler cihazınızda:</strong> Tüm belgeler yalnızca tarayıcınızın yerel
            IndexedDB deposunda saklanır; buluta gönderilmez.
          </li>
          <li>
            <strong>İzleme yok:</strong> Analitik betiği, üçüncü parti yazı tipi veya dış ağ isteği
            bulunmaz.
          </li>
          <li>
            <strong>Uçak modunda tam çalışma:</strong> İlk açılışta uygulama ve sözlük önbelleğe
            alındıktan sonra internet olmadan da açılır ve düzeltme yapar.
          </li>
        </ul>
        <p>
          Belgelerinizi dilediğiniz zaman <code>.txt</code> veya <code>.md</code> olarak
          bilgisayarınıza yedekleyebilirsiniz.
        </p>
      </div>
    </Dialog>
  );
}
