/* Beyond: WebKit's WTF::Vector as Bun's uWebSockets uses it (HTTP/2 and
   HTTP/3 header buffers), over std::vector. */
#pragma once
#include <stddef.h>
#include <span>
#include <vector>
namespace WTF {
template <typename T, size_t inlineCapacity = 0> class Vector : public std::vector<T> {
public:
    using std::vector<T>::vector;
    void append(const T &v) { this->push_back(v); }
    template <typename U> void append(const U *data, size_t n) { this->insert(this->end(), data, data + n); }
    void shrink(size_t n) { this->resize(n); }
    void grow(size_t n) { this->resize(n); }
    bool isEmpty() const { return this->empty(); }
    T *data() { return std::vector<T>::data(); }
    std::span<T> mutableSpan() { return std::span<T>(this->data(), this->size()); }
    std::span<const T> span() const { return std::span<const T>(std::vector<T>::data(), this->size()); }
};
}
